"use strict";

const fs = require("fs");
const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getFactionOwnerRecord,
} = require(path.join(__dirname, "../faction/factionState"));
const {
  getCorporationWarPermitStatus,
} = require(path.join(__dirname, "./warPermitState"));
const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  readAggressionSettings,
  readPersistedAggressionSettings,
  resolveFriendlyFireLegalAtTime,
} = require(path.join(__dirname, "./aggressionSettingsState"));
// Pure ID-range constants live in a dependency-free module so tests and other
// callers can import them without loading the database. Re-exported below.
const {
  CUSTOM_CORPORATION_ID_START,
  CUSTOM_ALLIANCE_ID_START,
  NPC_STARTER_CORPORATION_ID,
} = require(path.join(__dirname, "./corporationIdRanges"));

const CORPORATIONS_TABLE = "corporations";
const ALLIANCES_TABLE = "alliances";
const CHARACTERS_TABLE = "characters";
const STATIONS_TABLE = "stations";
const OWNED_TABLES = new Set([CORPORATIONS_TABLE, ALLIANCES_TABLE]);
const NPC_CORPORATION_SEED_VERSION = 2;
const OWNER_TYPE_CORPORATION = 2;
const OWNER_TYPE_ALLIANCE = 16159;
const OWNER_TYPE_CHARACTER = 1373;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const DEFAULT_CUSTOM_CORPORATION_LOGO = Object.freeze({
  shape1: 419,
  shape2: null,
  shape3: null,
  color1: null,
  color2: null,
  color3: null,
  typeface: null,
});
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DEFAULT_STATIC_JSONL_ROOTS = Object.freeze([
  path.join(REPO_ROOT, "data"),
  path.join(REPO_ROOT, "_local", "sde"),
]);

let npcCorporationCache = null;
let npcCharacterCache = null;
let cachedStaticJsonlDirectoryPath = null;
let cachedNpcCorporationSourcePath = null;
let cachedNpcCharacterSourcePath = null;
let corporationsBootstrapComplete = false;
let alliancesBootstrapComplete = false;
let corporationMembersIndexCache = null;
let corporationMembersIndexDirty = true;
let allianceCorporationsIndexCache = null;
let allianceCorporationsIndexDirty = true;

function getCharacterStateService() {
  return require(path.join(__dirname, "../character/characterState"));
}

function synchronizeCorporationSessionAffiliationBestEffort(
  affectedCharacterIDs,
  allianceID,
) {
  if (!Array.isArray(affectedCharacterIDs) || affectedCharacterIDs.length === 0) {
    return null;
  }

  try {
    const {
      synchronizeCorporationSessionAffiliation,
    } = require(path.join(__dirname, "./corporationSessionAffiliationSync"));
    return typeof synchronizeCorporationSessionAffiliation === "function"
      ? synchronizeCorporationSessionAffiliation(
          affectedCharacterIDs,
          allianceID,
        )
      : null;
  } catch (error) {
    // Corporation/alliance persistence is authoritative. Live transports and
    // space scenes are best-effort projections and cannot roll that state back.
    try {
      const log = require(path.join(__dirname, "../../utils/logger"));
      log.warn(
        `[CorporationState] Live alliance affiliation sync failed: ` +
          `${error && error.message ? error.message : String(error)}`,
      );
    } catch (_error) {
      // ignored: preserve the successful persisted operation even if logging is down.
    }
    return null;
  }
}

function updateCharacterStateRecord(characterID, mutator) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.updateCharacterRecord === "function"
    ? characterState.updateCharacterRecord(characterID, mutator)
    : { success: false, errorMsg: "CHARACTER_STATE_UNAVAILABLE" };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.trunc(numeric);
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeLocalizedText(value, fallback = "") {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    if (typeof value.en === "string" && value.en.trim()) {
      return value.en;
    }

    for (const localizedValue of Object.values(value)) {
      if (typeof localizedValue === "string" && localizedValue.trim()) {
        return localizedValue;
      }
    }
  }

  return fallback;
}

function normalizeNameKey(value) {
  return String(value || "").trim().toLowerCase();
}

function filetimeNowString() {
  return currentFileTime().toString();
}

function normalizeLogoPart(value) {
  return normalizePositiveInteger(value, null);
}

function normalizeCorporationLogo(record = {}) {
  const normalized = {
    ...record,
    shape1: normalizeLogoPart(record.shape1),
    shape2: normalizeLogoPart(record.shape2),
    shape3: normalizeLogoPart(record.shape3),
    color1: normalizeLogoPart(record.color1),
    color2: normalizeLogoPart(record.color2),
    color3: normalizeLogoPart(record.color3),
    typeface: normalizeLogoPart(record.typeface),
  };

  const hasLogoLayer =
    normalized.shape1 !== null ||
    normalized.shape2 !== null ||
    normalized.shape3 !== null;

  if (!record.isNPC && !hasLogoLayer) {
    return {
      ...normalized,
      ...DEFAULT_CUSTOM_CORPORATION_LOGO,
    };
  }

  return normalized;
}

function normalizeCorporationRecord(record = {}) {
  const normalized = normalizeCorporationLogo(record);
  normalized.solarSystemID = toPublicSolarSystemID(
    normalized.solarSystemID,
    null,
  );
  return normalized;
}

// Create an owned table on demand, unless this process may not write it.
//
// The alliance and corporation getters are on read paths that passive processes
// legitimately use (sovereignty normalisation, reporting tools). Calling
// ensureTable unconditionally made every one of those reads throw
// GAMESTORE_PROCESS_OWNERSHIP_VIOLATION. A reader cannot create the table
// anyway, and database.read still loads an existing one, so skipping the ensure
// costs a passive caller nothing.
function ensureOwnedTableIfWritable(tableName) {
  if (!OWNED_TABLES.has(tableName) || !database.mayMutateTable(tableName)) {
    return false;
  }
  database.ensureTable(tableName);
  return true;
}

function readTable(tableName, defaultPayload) {
  ensureOwnedTableIfWritable(tableName);
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(defaultPayload);
  }

  return cloneValue(result.data);
}

function readTableView(tableName, defaultPayload) {
  ensureOwnedTableIfWritable(tableName);
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return defaultPayload;
  }

  return result.data;
}

function writeTable(tableName, payload) {
  ensureOwnedTableIfWritable(tableName);
  const writeResult = database.write(tableName, "/", payload);
  if (writeResult && writeResult.success) {
    if (tableName === CORPORATIONS_TABLE || tableName === ALLIANCES_TABLE) {
      allianceCorporationsIndexDirty = true;
      allianceCorporationsIndexCache = null;
    }
  }
  return writeResult;
}

function normalizeCorporationTable(payload = {}) {
  return {
    _meta: {
      nextCustomCorporationID: normalizePositiveInteger(
        payload && payload._meta && payload._meta.nextCustomCorporationID,
        CUSTOM_CORPORATION_ID_START,
      ),
      npcSeedVersion: normalizeInteger(
        payload && payload._meta && payload._meta.npcSeedVersion,
        0,
      ),
    },
    records:
      payload && payload.records && typeof payload.records === "object"
        ? cloneValue(payload.records)
        : {},
  };
}

function normalizeAllianceTable(payload = {}) {
  return {
    ...(payload.affiliationChangesByCorporation ? {
      affiliationChangesByCorporation: cloneValue(payload.affiliationChangesByCorporation),
    } : {}),
    _meta: {
      nextCustomAllianceID: normalizePositiveInteger(
        payload && payload._meta && payload._meta.nextCustomAllianceID,
        CUSTOM_ALLIANCE_ID_START,
      ),
    },
    records:
      payload && payload.records && typeof payload.records === "object"
        ? cloneValue(payload.records)
        : {},
  };
}

function parseJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        // ignored: an unreadable line is dropped by the filter below
        return null;
      }
    })
    .filter(Boolean);
}

function getStaticJsonlRoots() {
  const roots = [];
  if (process.env.EVEJS_STATIC_JSONL_ROOT) {
    roots.push(path.resolve(process.env.EVEJS_STATIC_JSONL_ROOT));
  }
  roots.push(...DEFAULT_STATIC_JSONL_ROOTS);
  return roots;
}

function listStaticJsonlDirectoryCandidates(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }

  const candidates = [];
  const rootName = path.basename(rootPath);
  if (
    /^eve-online-static-data-\d+-jsonl$/i.test(rootName) &&
    fs.existsSync(path.join(rootPath, "npcCorporations.jsonl"))
  ) {
    candidates.push({
      name: rootName,
      fullPath: rootPath,
    });
  }

  try {
    const directoryEntries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of directoryEntries) {
      if (
        !entry ||
        !entry.isDirectory() ||
        !/^eve-online-static-data-\d+-jsonl$/i.test(entry.name)
      ) {
        continue;
      }
      const fullPath = path.join(rootPath, entry.name);
      if (!fs.existsSync(path.join(fullPath, "npcCorporations.jsonl"))) {
        continue;
      }
      candidates.push({
        name: entry.name,
        fullPath,
      });
    }
  } catch (_error) {
    return candidates;
  }

  return candidates;
}

function resolveLatestStaticJsonlDirectoryPath() {
  if (cachedStaticJsonlDirectoryPath !== null) {
    return cachedStaticJsonlDirectoryPath;
  }

  const candidateDirectory = getStaticJsonlRoots()
    .flatMap((rootPath) => listStaticJsonlDirectoryCandidates(rootPath))
    .sort((left, right) => right.name.localeCompare(left.name))[0];

  cachedStaticJsonlDirectoryPath = candidateDirectory
    ? candidateDirectory.fullPath
    : "";

  return cachedStaticJsonlDirectoryPath;
}

function resolveNpcCorporationSourcePath() {
  if (cachedNpcCorporationSourcePath !== null) {
    return cachedNpcCorporationSourcePath;
  }

  const directoryPath = resolveLatestStaticJsonlDirectoryPath();
  const candidatePath = directoryPath
    ? path.join(directoryPath, "npcCorporations.jsonl")
    : "";
  cachedNpcCorporationSourcePath = fs.existsSync(candidatePath)
    ? candidatePath
    : "";
  return cachedNpcCorporationSourcePath;
}

function resolveNpcCharacterSourcePath() {
  if (cachedNpcCharacterSourcePath !== null) {
    return cachedNpcCharacterSourcePath;
  }

  const directoryPath = resolveLatestStaticJsonlDirectoryPath();
  const candidatePath = directoryPath
    ? path.join(directoryPath, "npcCharacters.jsonl")
    : "";
  cachedNpcCharacterSourcePath = fs.existsSync(candidatePath)
    ? candidatePath
    : "";
  return cachedNpcCharacterSourcePath;
}

function loadNpcCorporations() {
  if (npcCorporationCache) {
    return npcCorporationCache;
  }

  npcCorporationCache = new Map(
    parseJsonlFile(resolveNpcCorporationSourcePath()).map((entry) => [
      normalizePositiveInteger(entry._key, 0),
      entry,
    ]),
  );
  return npcCorporationCache;
}

function loadNpcCharacters() {
  if (npcCharacterCache) {
    return npcCharacterCache;
  }

  npcCharacterCache = new Map(
    parseJsonlFile(resolveNpcCharacterSourcePath()).map((entry) => [
      normalizePositiveInteger(entry._key, 0),
      entry,
    ]),
  );
  return npcCharacterCache;
}

function readCharacters() {
  const result = database.read(CHARACTERS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  return result.data;
}

function markCorporationMembersIndexDirty() {
  corporationMembersIndexDirty = true;
  corporationMembersIndexCache = null;
}

function ensureCorporationMembersIndex() {
  if (!corporationMembersIndexDirty && corporationMembersIndexCache) {
    return corporationMembersIndexCache;
  }

  const nextIndex = new Map();
  for (const [characterID, characterRecord] of Object.entries(readCharacters())) {
    const corporationID = normalizePositiveInteger(
      characterRecord && characterRecord.corporationID,
      null,
    );
    const numericCharacterID = normalizePositiveInteger(characterID, null);
    if (!corporationID || !numericCharacterID) {
      continue;
    }
    if (!nextIndex.has(corporationID)) {
      nextIndex.set(corporationID, []);
    }
    nextIndex.get(corporationID).push(numericCharacterID);
  }

  for (const members of nextIndex.values()) {
    members.sort((left, right) => left - right);
  }

  corporationMembersIndexCache = nextIndex;
  corporationMembersIndexDirty = false;
  return corporationMembersIndexCache;
}

function ensureAllianceCorporationsIndex() {
  if (!allianceCorporationsIndexDirty && allianceCorporationsIndexCache) {
    return allianceCorporationsIndexCache;
  }

  ensureAlliancesInitialized();
  ensureCorporationsInitialized();

  const nextIndex = new Map();
  const allianceRecordsResult = database.read(ALLIANCES_TABLE, "/records");
  const corporationRecordsResult = database.read(CORPORATIONS_TABLE, "/records");
  const allianceRecords =
    allianceRecordsResult.success &&
    allianceRecordsResult.data &&
    typeof allianceRecordsResult.data === "object"
      ? allianceRecordsResult.data
      : {};
  const corporationRecords =
    corporationRecordsResult.success &&
    corporationRecordsResult.data &&
    typeof corporationRecordsResult.data === "object"
      ? corporationRecordsResult.data
      : {};

  for (const [allianceID, allianceRecord] of Object.entries(allianceRecords)) {
    const numericAllianceID = normalizePositiveInteger(allianceID, null);
    if (!numericAllianceID) {
      continue;
    }
    const members = new Set(
      (Array.isArray(allianceRecord && allianceRecord.memberCorporationIDs)
        ? allianceRecord.memberCorporationIDs
        : []
      )
        .map((corporationID) => normalizePositiveInteger(corporationID, null))
        .filter(Boolean),
    );
    nextIndex.set(numericAllianceID, members);
  }

  for (const corporationRecord of Object.values(corporationRecords)) {
    const corporationID = normalizePositiveInteger(
      corporationRecord && corporationRecord.corporationID,
      null,
    );
    const allianceID = normalizePositiveInteger(
      corporationRecord && corporationRecord.allianceID,
      null,
    );
    if (!corporationID || !allianceID) {
      continue;
    }
    if (!nextIndex.has(allianceID)) {
      nextIndex.set(allianceID, new Set());
    }
    nextIndex.get(allianceID).add(corporationID);
  }

  allianceCorporationsIndexCache = nextIndex;
  allianceCorporationsIndexDirty = false;
  return allianceCorporationsIndexCache;
}

function getCorporationMemberCount(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, 0) || 0;
  if (!numericCorporationID) {
    return 0;
  }
  return (ensureCorporationMembersIndex().get(numericCorporationID) || []).length;
}

function readStations() {
  const result = database.read(STATIONS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return [];
  }

  return Array.isArray(result.data.stations) ? result.data.stations : [];
}

// A corporation row's stationID is a headquarters *NPC station*: the client
// resolves it through stationSvc and reads station.stationTypeID from the
// result, so any other location (a structure, in particular) makes the client's
// corporation home page throw and spin forever. A character's home station may
// legitimately be a structure, so this value has to be filtered every time it is
// copied from a character into a corporation.
let npcStationCache = null;

function getNpcStationCache() {
  if (!npcStationCache || npcStationCache.size === 0) {
    const cache = new Map();
    for (const stationRecord of readStations()) {
      const stationID = normalizePositiveInteger(
        stationRecord && stationRecord.stationID,
        0,
      );
      if (!stationID) {
        continue;
      }
      cache.set(
        stationID,
        normalizePositiveInteger(stationRecord.solarSystemID, 0) || null,
      );
    }
    npcStationCache = cache;
  }
  return npcStationCache;
}

function resolveCorporationStationID(value) {
  const stationID = normalizePositiveInteger(value, 0);
  return stationID && getNpcStationCache().has(stationID) ? stationID : null;
}

function getNpcStationSolarSystemID(value) {
  const stationID = resolveCorporationStationID(value);
  return stationID ? getNpcStationCache().get(stationID) || null : null;
}

function buildTickerFromName(name, fallback = "CORP") {
  const text = String(name || "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim();
  if (!text) {
    return fallback;
  }

  const initials = text
    .split(/\s+/)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase()
    .slice(0, 5);
  if (initials.length >= 2) {
    return initials;
  }

  const compact = text.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  if (compact.length >= 2) {
    return compact.slice(0, 5);
  }

  return fallback;
}

function buildUniqueTicker(name, existingTickers = [], fallback = "CORP") {
  const baseTicker = buildTickerFromName(name, fallback);
  const used = new Set(
    existingTickers
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean),
  );

  if (!used.has(baseTicker)) {
    return baseTicker;
  }

  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${baseTicker}${String(index)}`.slice(0, 5);
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return baseTicker;
}

function isNpcCorporationID(corporationID) {
  const numericID = normalizePositiveInteger(corporationID, 0) || 0;
  return numericID >= 1000000 && numericID < 2000000;
}

function buildNpcCorporationRecord(rawRecord) {
  const corporationID = normalizePositiveInteger(rawRecord._key, 0) || 0;
  const corporationName = normalizeLocalizedText(
    rawRecord.name,
    `Corporation ${corporationID}`,
  );
  const tickerName =
    String(rawRecord.tickerName || "").trim() ||
    buildTickerFromName(corporationName, "NPC");

  return {
    corporationID,
    corporationName,
    tickerName,
    description: normalizeLocalizedText(rawRecord.description, ""),
    ceoID: normalizePositiveInteger(rawRecord.ceoID, null),
    creatorID: normalizePositiveInteger(rawRecord.ceoID, null),
    allianceID: null,
    stationID: normalizePositiveInteger(rawRecord.stationID, null),
    solarSystemID: normalizePositiveInteger(rawRecord.solarSystemID, null),
    factionID: normalizePositiveInteger(rawRecord.factionID, null),
    raceID: normalizePositiveInteger(rawRecord.raceID, null),
    deleted: rawRecord.deleted ? 1 : 0,
    shares: normalizeInteger(rawRecord.shares, 0),
    taxRate: Number(rawRecord.taxRate || 0),
    loyaltyPointTaxRate: 0.0,
    friendlyFire: 0,
    memberLimit: normalizeInteger(rawRecord.memberLimit, -1),
    url: "",
    hasPlayerPersonnelManager: Boolean(rawRecord.hasPlayerPersonnelManager),
    isNPC: true,
    createdAt: filetimeNowString(),
    shape1: null,
    shape2: null,
    shape3: null,
    color1: null,
    color2: null,
    color3: null,
    typeface: null,
  };
}

function ensureCorporationsInitialized() {
  if (corporationsBootstrapComplete) {
    const table = readTableView(CORPORATIONS_TABLE, {
      _meta: {
        nextCustomCorporationID: CUSTOM_CORPORATION_ID_START,
        npcSeedVersion: NPC_CORPORATION_SEED_VERSION,
      },
      records: {},
    });
    table._meta =
      table._meta && typeof table._meta === "object" ? table._meta : {};
    table.records =
      table.records && typeof table.records === "object" ? table.records : {};
    for (const [recordKey, storedRecord] of Object.entries(table.records)) {
      table.records[recordKey] = normalizeCorporationRecord(storedRecord);
    }
    return table;
  }

  const table = normalizeCorporationTable(
    readTable(CORPORATIONS_TABLE, {
      _meta: {
        nextCustomCorporationID: CUSTOM_CORPORATION_ID_START,
        npcSeedVersion: 0,
      },
      records: {},
    }),
  );
  const shouldRefreshNpcCorporations =
    table._meta.npcSeedVersion !== NPC_CORPORATION_SEED_VERSION;
  let mutated = shouldRefreshNpcCorporations;

  for (const [corporationID, rawRecord] of loadNpcCorporations().entries()) {
    const recordKey = String(corporationID);
    if (
      shouldRefreshNpcCorporations ||
      !table.records[recordKey] ||
      table.records[recordKey].isNPC !== true
    ) {
      table.records[recordKey] = buildNpcCorporationRecord(rawRecord);
      mutated = true;
    }
  }

  for (const [recordKey, storedRecord] of Object.entries(table.records)) {
    const normalizedRecord = normalizeCorporationRecord(storedRecord);
    if (JSON.stringify(storedRecord) !== JSON.stringify(normalizedRecord)) {
      table.records[recordKey] = normalizedRecord;
      mutated = true;
    }
  }

  if (table._meta.npcSeedVersion !== NPC_CORPORATION_SEED_VERSION) {
    table._meta.npcSeedVersion = NPC_CORPORATION_SEED_VERSION;
    mutated = true;
  }

  // A passive process keeps the normalised table it just derived, but cannot
  // write it back. The seeds it would have persisted are the database builder's
  // job, so there is nothing for a reader to repair here.
  if (mutated && database.mayMutateTable(CORPORATIONS_TABLE)) {
    writeTable(CORPORATIONS_TABLE, table);
  }

  corporationsBootstrapComplete = true;
  return table;
}

function recoverAllianceAffiliations(table, corporationID = null) {
  const recovered = require("./allianceAffiliationSettlement").reconcile(corporationID);
  if (!recovered.success) throw new Error(recovered.errorMsg || "ALLIANCE_AFFILIATION_PENDING");
  if (!table) return null;
  const current = database.read(ALLIANCES_TABLE, "/").data;
  if (!current || current === table) return table;
  // Cold initialization may have supplied defaults absent from an empty store.
  // Recovery can replace the cache root, but must not discard those defaults.
  return { ...table, ...current, records: current.records || table.records,
    _meta: { ...table._meta, ...current._meta,
      nextCustomAllianceID: normalizePositiveInteger(current._meta?.nextCustomAllianceID, table._meta.nextCustomAllianceID) } };
}

function ensureAlliancesInitialized() {
  if (alliancesBootstrapComplete) {
    const table = readTableView(ALLIANCES_TABLE, {
      _meta: {
        nextCustomAllianceID: CUSTOM_ALLIANCE_ID_START,
      },
      records: {},
    });
    table._meta =
      table._meta && typeof table._meta === "object" ? table._meta : {};
    table._meta.nextCustomAllianceID = normalizePositiveInteger(
      table._meta.nextCustomAllianceID, CUSTOM_ALLIANCE_ID_START,
    );
    table.records =
      table.records && typeof table.records === "object" ? table.records : {};
    return recoverAllianceAffiliations(table);
  }

  const table = normalizeAllianceTable(
    readTable(ALLIANCES_TABLE, {
      _meta: {
        nextCustomAllianceID: CUSTOM_ALLIANCE_ID_START,
      },
      records: {},
    }),
  );
  const normalizedNextAllianceID = normalizePositiveInteger(
    table._meta.nextCustomAllianceID,
    CUSTOM_ALLIANCE_ID_START,
  );

  if (normalizedNextAllianceID !== table._meta.nextCustomAllianceID) {
    table._meta.nextCustomAllianceID = normalizedNextAllianceID;
    if (database.mayMutateTable(ALLIANCES_TABLE)) {
      writeTable(ALLIANCES_TABLE, table);
    }
  }

  alliancesBootstrapComplete = true;
  return recoverAllianceAffiliations(table);
}

function getCharacterIDsInCorporation(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, 0) || 0;
  if (!numericCorporationID) {
    return [];
  }

  return cloneValue(
    ensureCorporationMembersIndex().get(numericCorporationID) || [],
  );
}

function invalidateAffiliationIndexes() {
  markCorporationMembersIndexDirty();
  allianceCorporationsIndexDirty = true;
  allianceCorporationsIndexCache = null;
}

function getAllianceCorporationIDs(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, 0) || 0;
  if (!numericAllianceID) {
    return [];
  }

  const members = ensureAllianceCorporationsIndex().get(numericAllianceID);
  if (!members) {
    return [];
  }
  return [...members].sort((left, right) => left - right);
}

function getCorporationRecord(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, 0) || 0;
  if (!numericCorporationID) {
    return null;
  }

  ensureCorporationsInitialized();
  recoverAllianceAffiliations(null, numericCorporationID);
  const result = database.read(
    CORPORATIONS_TABLE,
    `/records/${String(numericCorporationID)}`,
  );
  const storedRecord =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;
  if (!storedRecord) {
    return null;
  }

  const record = normalizeCorporationRecord(cloneValue(storedRecord));
  record.corporationID = numericCorporationID;
  record.allianceID = normalizePositiveInteger(record.allianceID, null);
  record.memberCount = getCorporationMemberCount(numericCorporationID);
  return record;
}

function getAllianceRecord(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, 0) || 0;
  if (!numericAllianceID) {
    return null;
  }

  ensureAlliancesInitialized();
  const result = database.read(
    ALLIANCES_TABLE,
    `/records/${String(numericAllianceID)}`,
  );
  const storedRecord =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;
  if (!storedRecord) {
    return null;
  }

  const record = cloneValue(storedRecord);
  record.allianceID = numericAllianceID;
  record.memberCorporationIDs = getAllianceCorporationIDs(numericAllianceID);
  record.memberCount = record.memberCorporationIDs.reduce(
    (count, corporationID) =>
      count + getCorporationMemberCount(corporationID),
    0,
  );
  return record;
}

function getCorporationOwnerRecord(corporationID) {
  const record = getCorporationRecord(corporationID);
  if (!record) {
    return null;
  }

  return {
    ownerID: record.corporationID,
    ownerName: record.corporationName,
    typeID: OWNER_TYPE_CORPORATION,
    gender: 0,
    tickerName: record.tickerName || null,
    factionID: normalizePositiveInteger(record.factionID, null),
  };
}

function getAllianceOwnerRecord(allianceID) {
  const record = getAllianceRecord(allianceID);
  if (!record) {
    return null;
  }

  return {
    ownerID: record.allianceID,
    ownerName: record.allianceName,
    typeID: OWNER_TYPE_ALLIANCE,
    gender: 0,
    tickerName: record.shortName || null,
  };
}

function getNpcCharacterOwnerRecord(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0) || 0;
  if (!numericCharacterID) {
    return null;
  }

  const rawRecord = loadNpcCharacters().get(numericCharacterID);
  if (!rawRecord) {
    return null;
  }

  return {
    ownerID: numericCharacterID,
    ownerName: normalizeLocalizedText(
      rawRecord.name,
      `Entity ${numericCharacterID}`,
    ),
    typeID: OWNER_TYPE_CHARACTER,
    gender: rawRecord.gender ? 1 : 0,
    tickerName: null,
  };
}

// An NPC character's row of the static data (npcCharacters): its name, bloodline, race, corporation, gender and
// its start there ("YYYY-MM-DD hh:mm:ss", UTC), or null for an id the table has not.
function getNpcCharacterRecord(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0) || 0;
  const rawRecord = numericCharacterID
    ? loadNpcCharacters().get(numericCharacterID)
    : null;
  if (!rawRecord) {
    return null;
  }

  return {
    characterID: numericCharacterID,
    characterName: normalizeLocalizedText(
      rawRecord.name,
      `Entity ${numericCharacterID}`,
    ),
    bloodlineID: normalizePositiveInteger(rawRecord.bloodlineID, null),
    raceID: normalizePositiveInteger(rawRecord.raceID, null),
    corporationID: normalizePositiveInteger(rawRecord.corporationID, null),
    gender: rawRecord.gender ? 1 : 0,
    startDate:
      typeof rawRecord.startDate === "string" ? rawRecord.startDate : null,
  };
}

function getOwnerLookupRecord(ownerID) {
  return (
    getCorporationOwnerRecord(ownerID) ||
    getAllianceOwnerRecord(ownerID) ||
    getFactionOwnerRecord(ownerID) ||
    getNpcCharacterOwnerRecord(ownerID) ||
    null
  );
}

function getAllianceShortNameRecord(allianceID) {
  const record = getAllianceRecord(allianceID);
  if (!record) {
    return null;
  }

  return {
    allianceID: record.allianceID,
    shortName: record.shortName || buildTickerFromName(record.allianceName, "ALLY"),
  };
}

function getCorporationStationSolarSystems(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, 0) || 0;
  if (!numericCorporationID) {
    return [];
  }

  const stationCountBySystemID = new Map();

  for (const stationRecord of readStations()) {
    const ownerID = normalizePositiveInteger(
      stationRecord && (stationRecord.corporationID || stationRecord.ownerID),
      0,
    );
    if (ownerID !== numericCorporationID) {
      continue;
    }

    const solarSystemID = normalizePositiveInteger(
      stationRecord && stationRecord.solarSystemID,
      0,
    );
    if (!solarSystemID) {
      continue;
    }

    stationCountBySystemID.set(
      solarSystemID,
      (stationCountBySystemID.get(solarSystemID) || 0) + 1,
    );
  }

  return [...stationCountBySystemID.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([solarSystemID, stationCount]) => ({
      ownerID: numericCorporationID,
      solarSystemID,
      stationCount,
    }));
}

function getCharacterCorporationIDForAuthority(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, null);
  const characterState = getCharacterStateService();
  if (
    !numericCharacterID ||
    !characterState ||
    typeof characterState.peekCharacterRecord !== "function"
  ) {
    return null;
  }
  const character = characterState.peekCharacterRecord(numericCharacterID);
  if (
    !character ||
    Boolean(character.isDeleted) ||
    Boolean(character.deletedAt)
  ) {
    return null;
  }
  return normalizePositiveInteger(character && character.corporationID, null);
}

function getCorporationAuthorityRecord(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return null;
  }

  ensureCorporationsInitialized();
  const result = database.read(
    CORPORATIONS_TABLE,
    `/records/${String(numericCorporationID)}`,
  );
  const record =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;
  if (
    !record ||
    normalizePositiveInteger(record.corporationID, null) !== numericCorporationID ||
    Boolean(record.deleted) ||
    record.isNPC !== false ||
    isNpcCorporationID(numericCorporationID)
  ) {
    return null;
  }

  return {
    corporationID: numericCorporationID,
    isNPC: false,
  };
}

// Authoritative combat check. Callers must supply the timestamp for the event
// being judged so scheduled 24-hour transitions cannot drift onto wall time.
// Any missing, malformed, or unavailable authority resolves to illegal.
function areCharactersFriendlyFireLegal(
  attackerCharacterID,
  targetCharacterID,
  options = {},
) {
  try {
    const attackerID = normalizePositiveInteger(attackerCharacterID, null);
    const targetID = normalizePositiveInteger(targetCharacterID, null);
    const nowMs = options && options.nowMs;
    if (
      !attackerID ||
      !targetID ||
      attackerID === targetID ||
      typeof nowMs !== "number" ||
      !Number.isFinite(nowMs) ||
      nowMs < 0
    ) {
      return false;
    }

    const corporationID = getCharacterCorporationIDForAuthority(targetID);
    if (!corporationID) {
      return false;
    }

    return isCharacterCorporationFriendlyFireLegal(
      attackerID,
      corporationID,
      options,
    );
  } catch (error) {
    // ignored: an unreadable setting counts as not legal, so friendly fire stays off
    return false;
  }
}

// Corporation-owned space property has no character principal to stand in for
// it. Keep the authority check on the corporation itself so callers do not
// synthesize an arbitrary member and accidentally inherit that member's other
// Crimewatch relationships.
function isCharacterCorporationFriendlyFireLegal(
  attackerCharacterID,
  targetCorporationID,
  options = {},
) {
  try {
    const attackerID = normalizePositiveInteger(attackerCharacterID, null);
    const corporationID = normalizePositiveInteger(targetCorporationID, null);
    const nowMs = options && options.nowMs;
    if (
      !attackerID ||
      !corporationID ||
      typeof nowMs !== "number" ||
      !Number.isFinite(nowMs) ||
      nowMs < 0 ||
      getCharacterCorporationIDForAuthority(attackerID) !== corporationID
    ) {
      return false;
    }

    const corporation = getCorporationAuthorityRecord(corporationID);
    if (!corporation) {
      return false;
    }

    const aggressionSettings = readPersistedAggressionSettings(corporationID, {
      isNpcCorporation: false,
    });
    if (!aggressionSettings) {
      return false;
    }

    const nowFiletime =
      BigInt(Math.trunc(nowMs)) * FILETIME_TICKS_PER_MS +
      FILETIME_EPOCH_OFFSET;
    return resolveFriendlyFireLegalAtTime(aggressionSettings, {
      isNpcCorporation: false,
      nowFiletime,
    });
  } catch (error) {
    // ignored: an unreadable setting counts as not legal, so friendly fire stays off
    return false;
  }
}

function getCorporationPublicInfo(corporationID) {
  const record = getCorporationRecord(corporationID);
  if (!record) {
    return null;
  }

  const aggressionSettings = readAggressionSettings(record.corporationID, {
    isNpcCorporation: Boolean(record.isNPC),
  });
  const currentFriendlyFire = resolveFriendlyFireLegalAtTime(aggressionSettings, {
    isNpcCorporation: Boolean(record.isNPC),
  })
    ? 1
    : 0;

  return {
    corporationID: record.corporationID,
    corporationName: record.corporationName,
    ticker: record.tickerName || "CORP",
    tickerName: record.tickerName || "CORP",
    ceoID: normalizePositiveInteger(record.ceoID, null),
    creatorID: normalizePositiveInteger(
      record.creatorID,
      normalizePositiveInteger(record.ceoID, null),
    ),
    allianceID: normalizePositiveInteger(record.allianceID, null),
    description: record.description || "",
    stationID: resolveCorporationStationID(record.stationID),
    solarSystemID: toPublicSolarSystemID(record.solarSystemID, null),
    shares: normalizeInteger(record.shares, 0),
    deleted: record.deleted ? 1 : 0,
    url: record.url || "",
    taxRate: Number(record.taxRate || 0),
    loyaltyPointTaxRate: Number(record.loyaltyPointTaxRate || 0),
    friendlyFire: currentFriendlyFire,
    allowWar: getCorporationWarPermitStatus(record.corporationID),
    memberCount: normalizeInteger(record.memberCount, 0),
    memberLimit: normalizeInteger(record.memberLimit, -1),
    allowedMemberRaceIDs: normalizeInteger(record.allowedMemberRaceIDs, 0),
    corporationType: normalizeInteger(record.corporationType, 0),
    minimumJoinStanding: Number(record.minimumJoinStanding || 0),
    sendCharTerminationMessage: record.sendCharTerminationMessage === undefined
      ? true
      : Boolean(record.sendCharTerminationMessage),
    createDate: String(record.createDate || record.createdAt || record.createDateTime || 0),
    aggressionEnableAfter:
      aggressionSettings && aggressionSettings.enableAfter
        ? String(aggressionSettings.enableAfter)
        : null,
    aggressionDisableAfter:
      aggressionSettings && aggressionSettings.disableAfter
        ? String(aggressionSettings.disableAfter)
        : null,
    isNPC: Boolean(record.isNPC),
    factionID: normalizePositiveInteger(record.factionID, null),
    warFactionID: normalizePositiveInteger(
      record.warFactionID,
      normalizePositiveInteger(record.factionID, null),
    ),
    raceID: normalizePositiveInteger(record.raceID, null),
    shape1: normalizeLogoPart(record.shape1),
    shape2: normalizeLogoPart(record.shape2),
    shape3: normalizeLogoPart(record.shape3),
    color1: normalizeLogoPart(record.color1),
    color2: normalizeLogoPart(record.color2),
    color3: normalizeLogoPart(record.color3),
    typeface: normalizeLogoPart(record.typeface),
  };
}

function getCorporationInfoRecord(corporationID) {
  const publicInfo = getCorporationPublicInfo(corporationID);
  if (!publicInfo) {
    return null;
  }

  return {
    corporationID: publicInfo.corporationID,
    corporationName: publicInfo.corporationName,
    ticker: publicInfo.ticker,
    tickerName: publicInfo.tickerName,
    ceoID: publicInfo.ceoID,
    creatorID: publicInfo.creatorID,
    allianceID: publicInfo.allianceID,
    description: publicInfo.description,
    stationID: publicInfo.stationID,
    solarSystemID: publicInfo.solarSystemID,
    shares: publicInfo.shares,
    deleted: publicInfo.deleted,
    url: publicInfo.url,
    taxRate: publicInfo.taxRate,
    loyaltyPointTaxRate: publicInfo.loyaltyPointTaxRate,
    friendlyFire: publicInfo.friendlyFire,
    allowWar: publicInfo.allowWar,
    memberCount: publicInfo.memberCount,
    memberLimit: publicInfo.memberLimit,
    allowedMemberRaceIDs: publicInfo.allowedMemberRaceIDs,
    corporationType: publicInfo.corporationType,
    minimumJoinStanding: publicInfo.minimumJoinStanding,
    sendCharTerminationMessage: publicInfo.sendCharTerminationMessage,
    createDate: publicInfo.createDate,
    aggressionEnableAfter: publicInfo.aggressionEnableAfter,
    aggressionDisableAfter: publicInfo.aggressionDisableAfter,
    isNPC: publicInfo.isNPC,
    factionID: publicInfo.factionID,
    warFactionID: publicInfo.warFactionID,
    raceID: publicInfo.raceID,
    shape1: publicInfo.shape1,
    shape2: publicInfo.shape2,
    shape3: publicInfo.shape3,
    color1: publicInfo.color1,
    color2: publicInfo.color2,
    color3: publicInfo.color3,
    typeface: publicInfo.typeface,
  };
}

function findCorporationByName(name) {
  const normalizedName = normalizeNameKey(name);
  if (!normalizedName) {
    return null;
  }

  const table = ensureCorporationsInitialized();
  return (
    Object.values(table.records)
      .map((record) => getCorporationRecord(record.corporationID))
      .find(
        (record) => normalizeNameKey(record && record.corporationName) === normalizedName,
      ) || null
  );
}

function findCorporationByTickerName(tickerName) {
  const normalizedTicker = String(tickerName || "").trim().toUpperCase();
  if (!normalizedTicker) {
    return null;
  }

  const table = ensureCorporationsInitialized();
  return (
    Object.values(table.records)
      .map((record) => getCorporationRecord(record.corporationID))
      .find(
        (record) => String((record && record.tickerName) || "").trim().toUpperCase() ===
          normalizedTicker,
      ) || null
  );
}

function findAllianceByName(name) {
  const normalizedName = normalizeNameKey(name);
  if (!normalizedName) {
    return null;
  }

  const table = ensureAlliancesInitialized();
  return (
    Object.values(table.records)
      .map((record) => getAllianceRecord(record.allianceID))
      .find(
        (record) =>
          normalizeNameKey(record && record.allianceName) === normalizedName ||
          normalizeNameKey(record && record.shortName) === normalizedName,
      ) || null
  );
}

function findAllianceByExactName(name) {
  const normalizedName = normalizeNameKey(name);
  if (!normalizedName) {
    return null;
  }

  const table = ensureAlliancesInitialized();
  return (
    Object.values(table.records)
      .map((record) => getAllianceRecord(record.allianceID))
      .find(
        (record) =>
          normalizeNameKey(record && record.allianceName) === normalizedName,
      ) || null
  );
}

function findAllianceByShortName(shortName) {
  const normalizedShortName = String(shortName || "").trim().toUpperCase();
  if (!normalizedShortName) {
    return null;
  }

  const table = ensureAlliancesInitialized();
  return (
    Object.values(table.records)
      .map((record) => getAllianceRecord(record.allianceID))
      .find(
        (record) =>
          String((record && record.shortName) || "").trim().toUpperCase() ===
          normalizedShortName,
      ) || null
  );
}

function setCorporationRecord(record) {
  const corporationID =
    normalizePositiveInteger(record && record.corporationID, 0) || 0;
  if (!corporationID) {
    return {
      success: false,
      errorMsg: "CORPORATION_ID_REQUIRED",
    };
  }

  // The initialized table is a live game-store view. Build the replacement
  // table without mutating that view so a rejected write cannot leak an
  // uncommitted corporation record into subsequent reads.
  const currentTable = ensureCorporationsInitialized();
  const table = {
    ...currentTable,
    records: { ...currentTable.records },
  };
  table.records[String(corporationID)] = normalizeCorporationRecord(
    cloneValue(record),
  );
  return writeTable(CORPORATIONS_TABLE, table);
}

function setCharacterAffiliation(characterID, corporationID, allianceID = null) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0) || 0;
  const numericCorporationID = normalizePositiveInteger(corporationID, 0) || 0;
  const normalizedAllianceID = normalizePositiveInteger(allianceID, null);

  if (!numericCharacterID || !numericCorporationID) {
    return {
      success: false,
      errorMsg: "INVALID_AFFILIATION",
    };
  }

  // Shared bookmark folders granted through the corporation or alliance go away
  // with the membership; the pilot's client keeps them until told
  // (OnSharedBookmarksFoldersAccessLost / AccessChanged).
  let bookmarkAccessBefore = null;
  try {
    bookmarkAccessBefore = require("../bookmark/bookmarkNotifications")
      .captureFolderAccess({ characterIDs: [numericCharacterID] });
  } catch (error) {
    require(path.join(__dirname, "../../utils/logger")).debug(`[CorporationState] bookmark access snapshot failed char=${numericCharacterID}: ${error.message}`);
  }

  let stagedCareer = false;
  const updateResult = updateCharacterStateRecord(numericCharacterID, (record) => {
    // Replayed membership transitions must flush evidence left in the cache by
    // an interrupted/refused durable checkpoint before acknowledging success.
    stagedCareer = Number(record.careerActivityEvidence?.metrics?.["social:corporation"]?.value) > 0;
    const nowFiletime = filetimeNowString();
    const currentCorporationID = normalizePositiveInteger(record.corporationID, 0);
    const currentAllianceID = normalizePositiveInteger(record.allianceID, null);
    const corporationChanged = currentCorporationID !== numericCorporationID;
    const allianceChanged = currentAllianceID !== normalizedAllianceID;
    const updatedRecord = {
      ...record,
      corporationID: numericCorporationID,
      allianceID: normalizedAllianceID || 0,
      allianceMemberStartDate: normalizedAllianceID
        ? allianceChanged
          ? nowFiletime
          : record.allianceMemberStartDate || nowFiletime
        : 0,
      startDateTime: corporationChanged
        ? nowFiletime
        : String(record.startDateTime || record.createDateTime || nowFiletime),
      // TQ application acceptance and NPC return rows start with a blank title
      // and no base/division/squadron. Assignments belong to the old membership.
      ...(corporationChanged
        ? { title: "", baseID: null, divisionID: null, squadronID: null }
        : {}),
    };
    const employmentHistory = Array.isArray(updatedRecord.employmentHistory)
      ? updatedRecord.employmentHistory.slice()
      : [];
    const lastEntry = employmentHistory.length
      ? employmentHistory[employmentHistory.length - 1]
      : null;

    if (
      corporationChanged &&
      normalizePositiveInteger(lastEntry && lastEntry.corporationID, 0) !==
        numericCorporationID
    ) {
      employmentHistory.push({
        corporationID: numericCorporationID,
        startDate: nowFiletime,
        deleted: 0,
      });
    }

    updatedRecord.employmentHistory = employmentHistory;
    if (corporationChanged && currentCorporationID > 0 &&
        getCorporationRecord(numericCorporationID)?.isNPC === false) {
      const staged = require("../career/careerEventLedger").stageCharacter(updatedRecord, numericCharacterID,
        { kind: "social", action: "corporation", id: "corporation:joined-player-corporation" });
      if (!staged.success) throw new Error(staged.errorMsg || "CAREER_CORPORATION_EVIDENCE_FAILED");
      stagedCareer = true;
      return staged.data.record;
    }
    return updatedRecord;
  });
  if (updateResult && updateResult.success) {
    if (stagedCareer) {
      const flushed = database.flushTableSync(CHARACTERS_TABLE);
      if (!flushed?.success) return flushed || { success: false, errorMsg: "CAREER_CORPORATION_FLUSH_FAILED" };
      require("../career/careerEventLedger").publishCommitted(numericCharacterID);
    }
    markCorporationMembersIndexDirty();
    if (bookmarkAccessBefore && bookmarkAccessBefore.size > 0) {
      try {
        require("../bookmark/bookmarkNotifications").notifyFolderAccessChanges(bookmarkAccessBefore);
      } catch (error) {
        require(path.join(__dirname, "../../utils/logger")).debug(`[CorporationState] bookmark access notice failed char=${numericCharacterID}: ${error.message}`);
      }
    }
  }
  return updateResult;
}

function setCorporationAlliance(corporationID, allianceID = null) {
  return require("./allianceAffiliationSettlement").change(corporationID, allianceID);
}

function findCorporationByFoundingOperationID(foundingOperationID) {
  const normalizedOperationID = String(foundingOperationID || "").trim();
  if (!normalizedOperationID) {
    return null;
  }
  const table = ensureCorporationsInitialized();
  const record = Object.values(table.records || {}).find(
    (candidate) =>
      candidate && candidate.foundingOperationID === normalizedOperationID,
  );
  return record ? getCorporationRecord(record.corporationID) : null;
}

function findAllianceByFoundingOperationID(foundingOperationID) {
  const normalizedOperationID = String(foundingOperationID || "").trim();
  if (!normalizedOperationID) {
    return null;
  }
  const table = ensureAlliancesInitialized();
  const record = Object.values(table.records || {}).find(
    (candidate) =>
      candidate && candidate.foundingOperationID === normalizedOperationID,
  );
  return record ? getAllianceRecord(record.allianceID) : null;
}

function createCustomCorporation(characterID, name, options = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return {
      success: false,
      errorMsg: "CORPORATION_NAME_REQUIRED",
    };
  }

  // An explicit headquarters choice wins (the GM command defaults it to a
  // station); otherwise the founder's home station is used when it is an NPC
  // station. A structure home station is legal for a character but not a
  // corporation headquarters, so it is dropped rather than copied.
  const requestedStationID = resolveCorporationStationID(
    options && options.stationID,
  );
  const requestedSolarSystemID = requestedStationID
    ? getNpcStationSolarSystemID(requestedStationID)
    : null;

  const foundingOperationID = String(
    options && options.foundingOperationID || "",
  ).trim();
  const resumedCorporation = foundingOperationID
    ? findCorporationByFoundingOperationID(foundingOperationID)
    : null;
  if (resumedCorporation) {
    const affiliationResult = setCharacterAffiliation(
      characterID,
      resumedCorporation.corporationID,
      resumedCorporation.allianceID || null,
    );
    return affiliationResult.success
      ? {
          success: true,
          duplicate: true,
          data: {
            corporationID: resumedCorporation.corporationID,
            corporationRecord: getCorporationRecord(
              resumedCorporation.corporationID,
            ),
            affectedCharacterIDs: [normalizePositiveInteger(characterID, 0)],
          },
        }
      : affiliationResult;
  }

  if (
    findCorporationByName(normalizedName) ||
    findAllianceByExactName(normalizedName)
  ) {
    return {
      success: false,
      errorMsg: "CORPORATION_NAME_TAKEN",
    };
  }

  const table = ensureCorporationsInitialized();
  const allianceTable = ensureAlliancesInitialized();
  const existingTickers = [
    ...Object.values(table.records).map(
      (record) => record && record.tickerName,
    ),
    ...Object.values(allianceTable.records).map(
      (record) => record && record.shortName,
    ),
  ];
  const corporationID = table._meta.nextCustomCorporationID;
  const characterRecord = readCharacters()[String(characterID)] || {};

  table._meta.nextCustomCorporationID += 1;
  table.records[String(corporationID)] = {
    corporationID,
    corporationName: normalizedName,
    tickerName: buildUniqueTicker(normalizedName, existingTickers, "CORP"),
    description: `Capsuleer corporation ${normalizedName}.`,
    ceoID: normalizePositiveInteger(characterID, null),
    creatorID: normalizePositiveInteger(characterID, null),
    allianceID: null,
    stationID: requestedStationID || resolveCorporationStationID(
      characterRecord.homeStationID ||
        characterRecord.cloneStationID ||
        characterRecord.stationID,
    ),
    solarSystemID: requestedStationID
      ? requestedSolarSystemID ||
        toPublicSolarSystemID(characterRecord.solarSystemID, null)
      : toPublicSolarSystemID(characterRecord.solarSystemID, null),
    factionID: null,
    raceID: null,
    deleted: 0,
    shares: 1000,
    taxRate: 0.0,
    loyaltyPointTaxRate: 0.0,
    friendlyFire: 0,
    memberLimit: 20,
    url: "",
    hasPlayerPersonnelManager: true,
    isNPC: false,
    allowedMemberRaceIDs: normalizePositiveInteger(characterRecord.raceID, 0) || 0,
    corporationType: 0,
    minimumJoinStanding: 0,
    sendCharTerminationMessage: true,
    createdAt: filetimeNowString(),
    ...(foundingOperationID ? { foundingOperationID } : {}),
    ...DEFAULT_CUSTOM_CORPORATION_LOGO,
  };

  const writeResult = writeTable(CORPORATIONS_TABLE, table);
  if (!writeResult.success) {
    return writeResult;
  }

  const affiliationResult = setCharacterAffiliation(characterID, corporationID, null);
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  return {
    success: true,
    data: {
      corporationID,
      corporationRecord: getCorporationRecord(corporationID),
      affectedCharacterIDs: [normalizePositiveInteger(characterID, 0)],
    },
  };
}

function createCustomAllianceForCorporation(
  characterID,
  corporationID,
  name,
  options = {},
) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return {
      success: false,
      errorMsg: "ALLIANCE_NAME_REQUIRED",
    };
  }

  const corporationRecord = getCorporationRecord(corporationID);
  if (!corporationRecord) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }

  if (corporationRecord.isNPC) {
    return {
      success: false,
      errorMsg: "CUSTOM_CORPORATION_REQUIRED",
    };
  }

  const foundingOperationID = String(
    options && options.foundingOperationID || "",
  ).trim();
  const resumedAlliance = foundingOperationID
    ? findAllianceByFoundingOperationID(foundingOperationID)
    : null;
  if (resumedAlliance) {
    const currentAllianceID = normalizePositiveInteger(
      corporationRecord.allianceID,
      null,
    );
    if (
      currentAllianceID &&
      currentAllianceID !== resumedAlliance.allianceID
    ) {
      return { success: false, errorMsg: "CORPORATION_ALREADY_IN_ALLIANCE" };
    }
    const affiliationResult = setCorporationAlliance(
      corporationRecord.corporationID,
      resumedAlliance.allianceID,
    );
    return affiliationResult.success
      ? {
          success: true,
          duplicate: true,
          data: {
            allianceID: resumedAlliance.allianceID,
            allianceRecord: getAllianceRecord(resumedAlliance.allianceID),
            affectedCharacterIDs: affiliationResult.data.affectedCharacterIDs,
          },
        }
      : affiliationResult;
  }

  if (normalizePositiveInteger(corporationRecord.allianceID, null)) {
    return {
      success: false,
      errorMsg: "CORPORATION_ALREADY_IN_ALLIANCE",
    };
  }

  if (
    findAllianceByExactName(normalizedName) ||
    findCorporationByName(normalizedName)
  ) {
    return {
      success: false,
      errorMsg: "ALLIANCE_NAME_TAKEN",
    };
  }

  const requestedShortName = String(options.shortName || "")
    .trim()
    .toUpperCase();
  if (
    requestedShortName &&
    (findAllianceByShortName(requestedShortName) ||
      findCorporationByTickerName(requestedShortName))
  ) {
    return {
      success: false,
      errorMsg: "ALLIANCE_SHORT_NAME_TAKEN",
    };
  }

  const table = ensureAlliancesInitialized();
  const corporationTable = ensureCorporationsInitialized();
  const existingTickers = [
    ...Object.values(table.records).map(
      (record) => record && record.shortName,
    ),
    ...Object.values(corporationTable.records).map(
      (record) => record && record.tickerName,
    ),
  ];
  const allianceID = table._meta.nextCustomAllianceID;
  const createdAt = filetimeNowString();

  table._meta.nextCustomAllianceID += 1;
  table.records[String(allianceID)] = {
    allianceID,
    allianceName: normalizedName,
    shortName: requestedShortName ||
      buildUniqueTicker(normalizedName, existingTickers, "ALLY"),
    creatorID: normalizePositiveInteger(characterID, null),
    creatorCharID: normalizePositiveInteger(characterID, null),
    creatorCorpID: corporationRecord.corporationID,
    executorCorporationID: corporationRecord.corporationID,
    description:
      options.description === undefined
        ? `Capsuleer alliance ${normalizedName}.`
        : String(options.description || ""),
    url: String(options.url || ""),
    memberCorporationIDs: [corporationRecord.corporationID],
    isNPC: false,
    deleted: 0,
    createdAt,
    createDate: createdAt,
    ...(foundingOperationID ? { foundingOperationID } : {}),
  };

  const writeResult = writeTable(ALLIANCES_TABLE, table);
  if (!writeResult.success) {
    return writeResult;
  }

  const affiliationResult = setCorporationAlliance(
    corporationRecord.corporationID,
    allianceID,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  return {
    success: true,
    data: {
      allianceID,
      allianceRecord: getAllianceRecord(allianceID),
      affectedCharacterIDs: affiliationResult.data.affectedCharacterIDs,
    },
  };
}

function joinCorporationToAllianceByName(corporationID, allianceName) {
  const recovered = require("./allianceAffiliationSettlement").reconcile(corporationID);
  if (!recovered.success) return recovered;
  const corporationRecord = getCorporationRecord(corporationID);
  if (!corporationRecord) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }

  if (corporationRecord.isNPC) {
    return {
      success: false,
      errorMsg: "CUSTOM_CORPORATION_REQUIRED",
    };
  }

  const allianceRecord = findAllianceByName(allianceName);
  if (!allianceRecord) {
    return {
      success: false,
      errorMsg: "ALLIANCE_NOT_FOUND",
    };
  }

  const affiliationResult = setCorporationAlliance(
    corporationRecord.corporationID,
    allianceRecord.allianceID,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  return {
    success: true,
    data: {
      allianceID: allianceRecord.allianceID,
      allianceRecord: getAllianceRecord(allianceRecord.allianceID),
      affectedCharacterIDs: affiliationResult.data.affectedCharacterIDs,
    },
  };
}

module.exports = {
  ALLIANCES_TABLE,
  CORPORATIONS_TABLE,
  CUSTOM_ALLIANCE_ID_START,
  CUSTOM_CORPORATION_ID_START,
  NPC_STARTER_CORPORATION_ID,
  areCharactersFriendlyFireLegal,
  isCharacterCorporationFriendlyFireLegal,
  createCustomAllianceForCorporation,
  createCustomCorporation,
  ensureAlliancesInitialized,
  ensureCorporationsInitialized,
  findAllianceByName,
  findAllianceByExactName,
  findAllianceByFoundingOperationID,
  findAllianceByShortName,
  findCorporationByName,
  findCorporationByFoundingOperationID,
  findCorporationByTickerName,
  getAllianceCorporationIDs,
  getAllianceOwnerRecord,
  getAllianceRecord,
  getAllianceShortNameRecord,
  getCharacterIDsInCorporation,
  invalidateAffiliationIndexes,
  resetCorporationMembersIndexForTests: invalidateAffiliationIndexes,
  synchronizeCorporationSessionAffiliationBestEffort,
  getCorporationInfoRecord,
  getCorporationOwnerRecord,
  getCorporationPublicInfo,
  getCorporationRecord,
  getCorporationStationSolarSystems,
  getNpcCharacterOwnerRecord,
  getNpcCharacterRecord,
  getOwnerLookupRecord,
  isNpcCorporationID,
  joinCorporationToAllianceByName,
  setCharacterAffiliation,
  setCorporationAlliance,
  setCorporationRecord,
};
