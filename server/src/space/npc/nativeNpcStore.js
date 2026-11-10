"use strict";

const path = require("path");
const miningCargoOwnerInstanceID = require("node:crypto").randomUUID();

const database = require(path.join(__dirname, "../../gameStore"));
const {
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../destiny/identity/entityID"));
const {
  buildChildEntityScopeMetadata,
  resolveEntityInteractionScope,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));

const TABLE = Object.freeze({
  ENTITIES: "npcEntities",
  MODULES: "npcModules",
  CARGO: "npcCargo",
  CONTROLLERS: "npcRuntimeControllers",
  WRECKS: "npcWrecks",
  WRECK_ITEMS: "npcWreckItems",
});

const ROOT = Object.freeze({
  [TABLE.ENTITIES]: {
    nextEntityID: 980000000000,
    entities: {},
  },
  [TABLE.MODULES]: {
    nextModuleID: 980100000000,
    modules: {},
  },
  [TABLE.CARGO]: {
    nextCargoID: 980200000000,
    cargo: {},
  },
  [TABLE.CONTROLLERS]: {
    controllers: {},
  },
  [TABLE.WRECKS]: {
    nextWreckID: 980300000000,
    wrecks: {},
  },
  [TABLE.WRECK_ITEMS]: {
    nextWreckItemID: 980400000000,
    items: {},
  },
});

// Each table owns a 100M-wide block of IDs beginning at its ROOT counter, and
// the two allocation modes split that block in half. Durable IDs advance from
// the persisted counter in the lower half. Transient IDs restart at the fixed
// upper-half base below on every process and are never written back to the
// store, so the two sequences can never mint the same ID: a table would need
// fifty million durable rows before the halves could meet. Reissuing transient
// IDs each boot is deliberate; consumers scope their idempotency keys to the
// boot that issued the ID.
const TRANSIENT_ID_BASES = Object.freeze({
  [TABLE.ENTITIES]: 980050000000,
  [TABLE.MODULES]: 980150000000,
  [TABLE.CARGO]: 980250000000,
  [TABLE.WRECKS]: 980350000000,
  [TABLE.WRECK_ITEMS]: 980450000000,
});

const transientCounters = {
  [TABLE.ENTITIES]: null,
  [TABLE.MODULES]: null,
  [TABLE.CARGO]: null,
  [TABLE.WRECKS]: null,
  [TABLE.WRECK_ITEMS]: null,
};

const controllerCache = {
  all: null,
  bySystem: new Map(),
  byEntityID: new Map(),
};

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function invalidateControllerCache() {
  controllerCache.all = null;
  controllerCache.bySystem.clear();
  controllerCache.byEntityID.clear();
}

// Adapted from ciefa/evejs-ciefa-fork 84136a92a1958118af2f9bc2888012a699fe2434.
// A row write replaces its cached copy; unrelated systems keep their arrays.
function updateControllerCache(entityID, controllerRecord = null) {
  if (!Array.isArray(controllerCache.all)) return;
  const key = String(entityID);
  const previous = controllerCache.byEntityID.get(key);
  const next = controllerRecord ? cloneValue(controllerRecord) : null;
  controllerCache.all = controllerCache.all.filter((row) => String(toPositiveInt(row && row.entityID, 0)) !== key);
  if (next) {
    controllerCache.all.push(next);
    controllerCache.all.sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
    controllerCache.byEntityID.set(key, next);
  } else {
    controllerCache.byEntityID.delete(key);
  }
  if (previous) controllerCache.bySystem.delete(toPositiveInt(previous.systemID, 0));
  if (next) controllerCache.bySystem.delete(toPositiveInt(next.systemID, 0));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

const INVALID_PERSISTENT_IDENTITY = "invalid-persistent-identity";
const NATIVE_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
  "dungeonSiteID",
  "dungeonSiteInstanceID",
]);
const NATIVE_SCOPE_BOOLEAN_FIELDS = Object.freeze([
  "airNpeBoardingShipPresentation",
  "airNpeTutorialDebris",
  "airNpeHostile",
  "dungeonMaterializedContainer",
  "dungeonMaterializedSiteContent",
  "dungeonSiteContentBonus",
  "dungeonSiteContentFailureExplodes",
  "dungeonSiteContentPersistsAfterResponse",
]);
const NATIVE_SCOPE_TEXT_FIELDS = Object.freeze([
  "airNpeHostileWave",
  "dungeonEncounterKey",
  "dungeonSiteContentKey",
  "dungeonSiteContentRole",
  "dungeonSiteContentAnalyzer",
  "dungeonSiteContentTrigger",
  "dungeonSiteContentLootProfile",
  "dungeonSiteContentHackingDifficulty",
]);
const NATIVE_SCOPE_ARRAY_FIELDS = Object.freeze([
  "dungeonSiteContentExplicitLoot",
  "dungeonSiteContentLootTags",
]);
const NATIVE_DUNGEON_BOOLEAN_MARKERS = new Set([
  "dungeonMaterializedContainer",
  "dungeonMaterializedSiteContent",
  "dungeonSiteContentBonus",
  "dungeonSiteContentFailureExplodes",
  "dungeonSiteContentPersistsAfterResponse",
]);
const NATIVE_DUNGEON_TEXT_MARKERS = new Set([
  "dungeonEncounterKey",
  "dungeonSiteContentKey",
  "dungeonSiteContentRole",
  "dungeonSiteContentAnalyzer",
  "dungeonSiteContentTrigger",
  "dungeonSiteContentLootProfile",
  "dungeonSiteContentHackingDifficulty",
]);
const NATIVE_AIR_BOOLEAN_MARKERS = new Set([
  "airNpeBoardingShipPresentation",
  "airNpeTutorialDebris",
  "airNpeHostile",
]);

function hasPresentScopeIdentity(source, key) {
  return Boolean(
    source &&
    Object.hasOwn(source, key) &&
    source[key] !== null &&
    source[key] !== undefined,
  );
}

function resolveStoredEntityScopeMetadata(sources = [], options = {}) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  const metadata = {};
  const invalidIdentityFields = new Set();
  const conflictingIdentityFields = new Set();
  const firstIdentityByField = new Map();

  for (const source of sourceList) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of NATIVE_SCOPE_ID_FIELDS) {
      if (!hasPresentScopeIdentity(source, key)) {
        continue;
      }
      const normalized = normalizePersistentEntityID(source[key]);
      if (normalized === null) {
        invalidIdentityFields.add(key);
        metadata[key] = INVALID_PERSISTENT_IDENTITY;
        continue;
      }
      if (
        firstIdentityByField.has(key) &&
        String(firstIdentityByField.get(key)) !== String(normalized)
      ) {
        conflictingIdentityFields.add(key);
        metadata[key] = INVALID_PERSISTENT_IDENTITY;
        continue;
      }
      firstIdentityByField.set(key, normalized);
      if (!invalidIdentityFields.has(key) && !conflictingIdentityFields.has(key)) {
        metadata[key] = toJSONSafeEntityID(normalized);
      }
    }
    for (const key of NATIVE_SCOPE_BOOLEAN_FIELDS) {
      if (source[key] === true) {
        metadata[key] = true;
      }
    }
    for (const key of NATIVE_SCOPE_TEXT_FIELDS) {
      const normalized = String(source[key] == null ? "" : source[key]).trim();
      if (normalized) {
        metadata[key] = normalized;
      }
    }
    for (const key of NATIVE_SCOPE_ARRAY_FIELDS) {
      if (Array.isArray(source[key])) {
        metadata[key] = cloneValue(source[key]);
      }
    }
  }

  if (
    options.projectAirInstanceToDungeonSite === true &&
    normalizePersistentEntityID(metadata.airNpeInstanceID) !== null &&
    !invalidIdentityFields.has("dungeonSiteInstanceID") &&
    !conflictingIdentityFields.has("dungeonSiteInstanceID")
  ) {
    metadata.dungeonSiteInstanceID = metadata.airNpeInstanceID;
  }

  const hasDungeonSiteContentOrID = Boolean(
    normalizePersistentEntityID(metadata.dungeonSiteID) !== null ||
    [...NATIVE_DUNGEON_BOOLEAN_MARKERS].some(
      (key) => metadata[key] === true,
    ) ||
    [...NATIVE_DUNGEON_TEXT_MARKERS].some(
      (key) => String(metadata[key] == null ? "" : metadata[key]).trim(),
    ) ||
    NATIVE_SCOPE_ARRAY_FIELDS.some((key) => Array.isArray(metadata[key]))
  );
  const hasAirOwnerOperationOrPresentation = Boolean(
    normalizePersistentEntityID(metadata.airNpeOwnerCharacterID) !== null ||
    normalizePersistentEntityID(metadata.airNpeOperationID) !== null ||
    [...NATIVE_AIR_BOOLEAN_MARKERS].some((key) => metadata[key] === true) ||
    String(metadata.airNpeHostileWave == null ? "" : metadata.airNpeHostileWave).trim()
  );
  const missingRequiredIdentityFields = [];
  if (
    hasDungeonSiteContentOrID &&
    normalizePersistentEntityID(metadata.dungeonSiteInstanceID) === null
  ) {
    missingRequiredIdentityFields.push("dungeonSiteInstanceID");
  }
  if (
    hasAirOwnerOperationOrPresentation &&
    normalizePersistentEntityID(metadata.airNpeInstanceID) === null
  ) {
    missingRequiredIdentityFields.push("airNpeInstanceID");
  }

  const success =
    invalidIdentityFields.size === 0 &&
    conflictingIdentityFields.size === 0 &&
    missingRequiredIdentityFields.length === 0;
  return {
    success,
    errorMsg: success ? null : "NPC_PRIVATE_SCOPE_INVALID",
    data: {
      metadata,
      invalidIdentityFields: [...invalidIdentityFields],
      conflictingIdentityFields: [...conflictingIdentityFields],
      missingRequiredIdentityFields,
    },
  };
}

function validateStoredEntityScopeMetadata(value = {}, options = {}) {
  return resolveStoredEntityScopeMetadata([value], options);
}

function buildStoredEntityScopeMetadata(value = {}, options = {}) {
  return validateStoredEntityScopeMetadata(value, options).data.metadata;
}

function readRoot(tableName) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(ROOT[tableName]);
  }
  const root = {
    ...cloneValue(ROOT[tableName]),
    ...cloneValue(result.data),
  };
  return root;
}

// Roots whose shape has already been verified, keyed by the store's live object.
//
// Verifying cost a deep clone of the table plus two full JSON.stringify of it,
// and every collection read, row write and row removal paid it. The store hands
// back its live root and mutates it in place for nested writes, so that object's
// identity is a precise marker: while it is the same object the shape it was
// given still holds. Replacing the root wholesale yields a new object and the
// check runs again.
const shapedRootsByTable = new WeakMap();

function ensureRootShape(tableName) {
  const result = database.read(tableName, "/");
  const existingRoot = result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
  if (existingRoot && shapedRootsByTable.get(existingRoot) === tableName) {
    return existingRoot;
  }

  const normalizedRoot = cloneValue(readRoot(tableName));
  if (!existingRoot || JSON.stringify(existingRoot) !== JSON.stringify(normalizedRoot)) {
    database.write(tableName, "/", normalizedRoot);
    const written = database.read(tableName, "/");
    const writtenRoot = written.success && written.data && typeof written.data === "object"
      ? written.data
      : normalizedRoot;
    shapedRootsByTable.set(writtenRoot, tableName);
    return writtenRoot;
  }

  shapedRootsByTable.set(existingRoot, tableName);
  return existingRoot;
}

function readCollectionRaw(tableName, key) {
  const root = ensureRootShape(tableName);
  return root && typeof root === "object" && root[key] && typeof root[key] === "object"
    ? root[key]
    : {};
}

function readCollection(tableName, key) {
  return cloneValue(readCollectionRaw(tableName, key));
}

// Preserve independent public results without serializing unrelated rows.
function readCollectionRow(tableName, key, rowID) {
  const row = readCollectionRaw(tableName, key)[String(rowID)];
  return row == null ? null : cloneValue(row);
}

function readCollectionRows(tableName, key, predicate) {
  return Object.values(readCollectionRaw(tableName, key))
    .filter((row) => row != null && predicate(row))
    .map((row) => cloneValue(row));
}

function writeCollectionRow(tableName, collectionKey, rowID, value, options = {}) {
  ensureRootShape(tableName);
  return database.write(
    tableName,
    `/${collectionKey}/${String(rowID)}`,
    cloneValue(value),
    options,
  );
}

function removeCollectionRow(tableName, collectionKey, rowID) {
  ensureRootShape(tableName);
  return database.remove(tableName, `/${collectionKey}/${String(rowID)}`);
}

function allocateID(tableName, counterKey, options = {}) {
  if (options.transient === true) {
    if (!Number.isInteger(transientCounters[tableName])) {
      transientCounters[tableName] = TRANSIENT_ID_BASES[tableName];
    }
    const nextID = transientCounters[tableName];
    transientCounters[tableName] += 1;
    return {
      success: true,
      data: nextID,
    };
  }

  const root = ensureRootShape(tableName);
  const nextID = Math.max(
    toPositiveInt(root && root[counterKey], 0),
    toPositiveInt(ROOT[tableName] && ROOT[tableName][counterKey], 0),
  );
  // ID counters are authoritative store metadata, not transient runtime rows.
  // Persisting them avoids collisions without ever transient-marking the whole
  // table snapshot.
  //
  // Written at its own path rather than by replacing the root: a whole-root write
  // installs a new object, which both deep-compares the table and discards the
  // verified-shape marker, so allocating an ID would re-verify the shape on the
  // next access.
  const writeResult = database.write(
    tableName,
    `/${counterKey}`,
    nextID + 1,
  );
  if (!writeResult.success) {
    return {
      success: false,
      errorMsg: writeResult.errorMsg || "NPC_NATIVE_ID_ALLOCATE_FAILED",
    };
  }
  return {
    success: true,
    data: nextID,
  };
}

function allocateEntityID(options = {}) {
  return allocateID(TABLE.ENTITIES, "nextEntityID", options);
}

function allocateModuleID(options = {}) {
  return allocateID(TABLE.MODULES, "nextModuleID", options);
}

function allocateCargoID(options = {}) {
  return allocateID(TABLE.CARGO, "nextCargoID", options);
}

function allocateWreckID(options = {}) {
  return allocateID(TABLE.WRECKS, "nextWreckID", options);
}

function allocateWreckItemID(options = {}) {
  return allocateID(TABLE.WRECK_ITEMS, "nextWreckItemID", options);
}

function listNativeEntities() {
  return Object.values(readCollection(TABLE.ENTITIES, "entities"))
    .sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
}

function getNativeEntity(entityID) {
  return readCollectionRow(TABLE.ENTITIES, "entities", entityID);
}

function upsertNativeEntity(entityRecord, options = {}) {
  const entityID = toPositiveInt(entityRecord && entityRecord.entityID, 0);
  if (!entityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_ENTITY_ID_REQUIRED",
    };
  }
  const scopeResolution = validateStoredEntityScopeMetadata(entityRecord);
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  return writeCollectionRow(
    TABLE.ENTITIES,
    "entities",
    entityID,
    {
      ...entityRecord,
      ...scopeResolution.data.metadata,
    },
    options,
  );
}

function listNativeEntitiesForSystem(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  return readCollectionRows(TABLE.ENTITIES, "entities",
    (entity) => toPositiveInt(entity && entity.systemID, 0) === normalizedSystemID,
  ).sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
}

function removeNativeEntity(entityID) {
  return removeCollectionRow(TABLE.ENTITIES, "entities", entityID);
}

function listNativeModulesForEntity(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  return readCollectionRows(TABLE.MODULES, "modules",
    (moduleRecord) => toPositiveInt(moduleRecord && moduleRecord.entityID, 0) === normalizedEntityID,
  ).sort((left, right) => Number(left.moduleID || 0) - Number(right.moduleID || 0));
}

function upsertNativeModule(moduleRecord, options = {}) {
  const moduleID = toPositiveInt(moduleRecord && moduleRecord.moduleID, 0);
  if (!moduleID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_MODULE_ID_REQUIRED",
    };
  }
  return writeCollectionRow(
    TABLE.MODULES,
    "modules",
    moduleID,
    moduleRecord,
    options,
  );
}

function removeNativeModule(moduleID) {
  return removeCollectionRow(TABLE.MODULES, "modules", moduleID);
}

function listNativeCargoForEntity(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  return readCollectionRows(TABLE.CARGO, "cargo", (row) => (
    toPositiveInt(row.entityID, 0) === normalizedEntityID && row.miningDeleted !== true &&
    (!row.miningOwnerInstanceID || row.miningOwnerInstanceID === miningCargoOwnerInstanceID)
  )).sort((left, right) => Number(left.cargoID || 0) - Number(right.cargoID || 0));
}

function upsertNativeCargo(cargoRecord, options = {}) {
  const cargoID = toPositiveInt(cargoRecord && cargoRecord.cargoID, 0);
  if (!cargoID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_CARGO_ID_REQUIRED",
    };
  }
  const current = getNativeCargo(cargoID);
  if (current?.miningRevision) {
    const unchanged = JSON.stringify(miningCargoContent(current)) === JSON.stringify(miningCargoContent(cargoRecord));
    cargoRecord = { ...miningCargoContent(cargoRecord),
      miningRevision: current.miningRevision + (unchanged ? 0 : 1),
      miningMutation: unchanged ? current.miningMutation : null };
  }
  return writeCollectionRow(
    TABLE.CARGO,
    "cargo",
    cargoID,
    cargoRecord,
    options,
  );
}

function getNativeCargo(cargoID) {
  const id = toPositiveInt(cargoID, 0);
  if (!id) return null;
  ensureRootShape(TABLE.CARGO);
  const result = database.read(TABLE.CARGO, `/cargo/${id}`);
  return result.success && result.data && !result.data.miningDeleted ? cloneValue(result.data) : null;
}

function miningCargoContent(record) {
  if (!record || record.miningDeleted) return null;
  const { miningRevision, miningMutation, miningDeleted, ...content } = record;
  return content;
}

// One row contains both quantity and receipt. Deletions retain a hidden tombstone
// so a crash/retry cannot recreate removed cargo or undo a newer mutation.
function applyMiningCargoMutation(mutation) {
  const id = toPositiveInt(mutation?.cargoID, 0);
  if (!id || !mutation?.commandID || !Number.isSafeInteger(mutation.expectedRevision)) {
    return { success: false, errorMsg: "NPC_MINING_CARGO_MUTATION_INVALID" };
  }
  ensureRootShape(TABLE.CARGO);
  const raw = database.read(TABLE.CARGO, `/cargo/${id}`);
  const current = raw.success && raw.data ? cloneValue(raw.data) : null;
  const previous = miningCargoContent(mutation.previous);
  const next = miningCargoContent(mutation.next);
  const fingerprint = JSON.stringify([id, mutation.expectedRevision, previous, next, mutation.requiredPreviousCommandID || null, mutation.disposition || null]);
  if (current?.miningMutation?.commandID === mutation.commandID) {
    return current.miningMutation.fingerprint === fingerprint
      ? { success: true, duplicate: true, data: { cargoID: id } }
      : { success: false, errorMsg: "NPC_MINING_CARGO_COMMAND_CONFLICT" };
  }
  if (Number(current?.miningRevision || 0) !== mutation.expectedRevision ||
      JSON.stringify(miningCargoContent(current)) !== JSON.stringify(previous) ||
      (mutation.requiredPreviousCommandID && current?.miningMutation?.commandID !== mutation.requiredPreviousCommandID)) {
    return { success: false, errorMsg: "NPC_MINING_CARGO_MUTATION_STALE" };
  }
  if (next && !mutation.transient && !next.miningOwnerInstanceID && !getNativeEntity(next.entityID)) {
    return { success: false, errorMsg: "NPC_NOT_FOUND" };
  }
  const row = { ...(next || previous || { cargoID: id }),
    ...(next ? {} : { quantity: 0, miningDeleted: true,
      miningDisposition: mutation.disposition || "removed",
      miningRetiredQuantity: ["owner-retired", "hauled", "despawn"].includes(mutation.disposition) ? Number(previous?.quantity || 0) : 0 }),
    miningRevision: mutation.expectedRevision + 1,
    miningMutation: { commandID: mutation.commandID, fingerprint } };
  const written = writeCollectionRow(TABLE.CARGO, "cargo", id, row, { transient: mutation.transient === true });
  if (!written?.success) return written;
  try {
    const flushed = mutation.transient ? { success: true } : flushNativeCargoSync();
    if (flushed?.success) return { success: true, data: { cargoID: id } };
    if (current) writeCollectionRow(TABLE.CARGO, "cargo", id, current, { transient: mutation.transient === true });
    else removeCollectionRow(TABLE.CARGO, "cargo", id);
    return flushed || { success: false, errorMsg: "NPC_MINING_CARGO_FLUSH_FAILED" };
  } catch (error) {
    if (current) writeCollectionRow(TABLE.CARGO, "cargo", id, current, { transient: mutation.transient === true });
    else removeCollectionRow(TABLE.CARGO, "cargo", id);
    throw error;
  }
}

function flushNativeCargoSync() { return database.flushTableSync(TABLE.CARGO); }

function retirePreviousMiningCargoOwners() {
  let retiredQuantity = 0;
  for (const row of Object.values(readCollection(TABLE.CARGO, "cargo"))) {
    if (row.miningDeleted || !row.miningOwnerInstanceID || row.miningOwnerInstanceID === miningCargoOwnerInstanceID) continue;
    const result = applyMiningCargoMutation({ commandID: `retire:${row.cargoID}:${row.miningOwnerInstanceID}`,
      cargoID: row.cargoID, previous: row, next: null, expectedRevision: Number(row.miningRevision || 0),
      disposition: "owner-retired" });
    if (!result.success) return result;
    retiredQuantity += row.quantity;
  }
  return { success: true, retiredQuantity };
}

function listMiningCargoRetirements() {
  return Object.values(readCollection(TABLE.CARGO, "cargo")).filter(row => row.miningDeleted && row.miningRetiredQuantity > 0);
}

function removeNativeCargo(cargoID, options = {}) {
  const row = getNativeCargo(cargoID);
  if (row?.miningRevision > 0) {
    return applyMiningCargoMutation({ commandID: `remove:${cargoID}:${row.miningRevision}:${options.disposition || "despawn"}`,
      cargoID: Number(cargoID), previous: row, next: null, expectedRevision: row.miningRevision,
      disposition: options.disposition || "despawn" });
  }
  return removeCollectionRow(TABLE.CARGO, "cargo", cargoID);
}

function miningCargoTransferKey(entityID, transient) {
  return `${transient ? miningCargoOwnerInstanceID : "persistent"}:${entityID}`;
}
function getMiningCargoWreckTransfer(entityID, transient) {
  ensureRootShape(TABLE.CARGO);
  const result = database.read(TABLE.CARGO, `/miningTransfers/${miningCargoTransferKey(entityID, transient)}`);
  return result.success && result.data ? cloneValue(result.data) : null;
}
let indexedMiningTransfers;
let pendingMiningTransfersByActor = new Map();
function saveMiningCargoTransfer(key, record) {
  indexedMiningTransfers = undefined;
  const previous = database.read(TABLE.CARGO, `/miningTransfers/${key}`);
  const before = previous.success && previous.data ? cloneValue(previous.data) : null;
  const result = writeCollectionRow(TABLE.CARGO, "miningTransfers", key, record);
  if (!result.success) return result;
  try {
    const flushed = flushNativeCargoSync();
    if (flushed?.success) return { success: true };
    if (before) writeCollectionRow(TABLE.CARGO, "miningTransfers", key, before);
    else removeCollectionRow(TABLE.CARGO, "miningTransfers", key);
    return flushed;
  } catch (error) {
    if (before) writeCollectionRow(TABLE.CARGO, "miningTransfers", key, before);
    else removeCollectionRow(TABLE.CARGO, "miningTransfers", key);
    throw error;
  }
}
function settleMiningCargoWreckTransfer(key, record) {
  if (record.status === "completed") return { success: true, duplicate: true, data: record };
  const wreck = upsertNativeWreck(record.wreck);
  if (!wreck.success) return wreck;
  for (const item of record.items) {
    const written = upsertNativeWreckItem(item);
    if (!written.success) return written;
  }
  const destination = database.flushTablesSync([TABLE.WRECKS, TABLE.WRECK_ITEMS]);
  if (!destination.success) return destination;
  for (const row of record.cargo) {
    const removed = applyMiningCargoMutation({ commandID: `wreck:${key}:${row.cargoID}`,
      cargoID: row.cargoID, previous: row, next: null,
      expectedRevision: row.miningRevision, disposition: "wreck" });
    if (!removed.success) return removed;
  }
  const removed = removeNativeEntityCascade(record.entityID, { skipMiningRecovery: true });
  if (!removed.success) return removed;
  const source = database.flushTablesSync([TABLE.ENTITIES, TABLE.MODULES, TABLE.CONTROLLERS, TABLE.CARGO]);
  if (!source.success) return source;
  const completed = { ...record, status: "completed" };
  const saved = saveMiningCargoTransfer(key, completed);
  return saved.success ? { success: true, data: completed } : saved;
}
function commitMiningCargoWreckTransfer({ entityID, transient, wreck, items, cargo }) {
  const key = miningCargoTransferKey(entityID, transient);
  const existing = readCollection(TABLE.CARGO, "miningTransfers")[key];
  if (existing) return settleMiningCargoWreckTransfer(key, existing);
  // Reserve positive destination IDs before publishing the frozen manifest.
  const counters = database.flushTablesSync([TABLE.WRECKS, TABLE.WRECK_ITEMS]);
  if (!counters.success) return counters;
  const record = { status: "pending", entityID, wreck: { ...wreck, transient: false, miningCargoTransferKey: key },
    items: items.map(item => ({ ...item, transient: false })), cargo: cloneValue(cargo) };
  const saved = saveMiningCargoTransfer(key, record);
  return saved.success ? settleMiningCargoWreckTransfer(key, record) : saved;
}
function reconcileMiningCargoWreckTransfers(entityID = 0) {
  ensureRootShape(TABLE.CARGO);
  const root = database.read(TABLE.CARGO, "/miningTransfers").data || null;
  if (root !== indexedMiningTransfers) {
    indexedMiningTransfers = root;
    pendingMiningTransfersByActor = new Map();
    for (const entry of Object.entries(root || {})) {
      if (entry[1].status !== "pending") continue;
      if (!pendingMiningTransfersByActor.has(entry[1].entityID)) pendingMiningTransfersByActor.set(entry[1].entityID, []);
      pendingMiningTransfersByActor.get(entry[1].entityID).push(entry);
    }
  }
  const entries = entityID ? pendingMiningTransfersByActor.get(Number(entityID)) || []
    : [...pendingMiningTransfersByActor.values()].flat();
  for (const [key, record] of entries) {
    const result = settleMiningCargoWreckTransfer(key, record);
    if (!result.success) return result;
  }
  return { success: true };
}

function listNativeControllers() {
  if (Array.isArray(controllerCache.all)) {
    return controllerCache.all;
  }

  const allControllers = Object.values(readCollection(TABLE.CONTROLLERS, "controllers"))
    .sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
  controllerCache.all = allControllers;
  controllerCache.byEntityID = new Map(
    allControllers.map((controller) => [String(toPositiveInt(controller && controller.entityID, 0)), controller]),
  );
  return allControllers;
}

function listNativeControllersForSystem(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  if (!normalizedSystemID) {
    return [];
  }
  if (controllerCache.bySystem.has(normalizedSystemID)) {
    return controllerCache.bySystem.get(normalizedSystemID);
  }

  const systemControllers = listNativeControllers().filter(
    (controller) => toPositiveInt(controller && controller.systemID, 0) === normalizedSystemID,
  );
  controllerCache.bySystem.set(normalizedSystemID, systemControllers);
  return systemControllers;
}

function getNativeController(entityID) {
  const normalizedEntityID = String(toPositiveInt(entityID, 0));
  if (!normalizedEntityID || normalizedEntityID === "0") {
    return null;
  }
  listNativeControllers();
  return controllerCache.byEntityID.get(normalizedEntityID) || null;
}

function upsertNativeController(controllerRecord, options = {}) {
  const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
  if (!entityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_CONTROLLER_ID_REQUIRED",
    };
  }
  const writeResult = writeCollectionRow(
    TABLE.CONTROLLERS,
    "controllers",
    entityID,
    controllerRecord,
    options,
  );
  if (writeResult && writeResult.success) {
    updateControllerCache(entityID, controllerRecord);
  }
  return writeResult;
}

function removeNativeController(entityID) {
  const removeResult = removeCollectionRow(TABLE.CONTROLLERS, "controllers", entityID);
  if (removeResult && removeResult.success) {
    updateControllerCache(entityID);
  }
  return removeResult;
}

function removeNativeEntityCascade(entityID, options = {}) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!normalizedEntityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_ENTITY_ID_REQUIRED",
    };
  }

  if (!options.skipMiningRecovery) {
    const recovered = require("../../services/mining/miningCargoCommits").reconcileActor(normalizedEntityID);
    if (!recovered.success) return recovered;
  }

  for (const moduleRecord of listNativeModulesForEntity(normalizedEntityID)) {
    const removeResult = removeNativeModule(moduleRecord.moduleID);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "NPC_NATIVE_MODULE_REMOVE_FAILED",
      };
    }
  }
  for (const cargoRecord of listNativeCargoForEntity(normalizedEntityID)) {
    const removeResult = removeNativeCargo(cargoRecord.cargoID);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "NPC_NATIVE_CARGO_REMOVE_FAILED",
      };
    }
  }
  if (getNativeController(normalizedEntityID)) {
    const controllerRemoveResult = removeNativeController(normalizedEntityID);
    if (!controllerRemoveResult || controllerRemoveResult.success !== true) {
      return controllerRemoveResult || {
        success: false,
        errorMsg: "NPC_NATIVE_CONTROLLER_REMOVE_FAILED",
      };
    }
  }
  if (getNativeEntity(normalizedEntityID)) {
    const entityRemoveResult = removeNativeEntity(normalizedEntityID);
    if (!entityRemoveResult || entityRemoveResult.success !== true) {
      return entityRemoveResult || {
        success: false,
        errorMsg: "NPC_NATIVE_ENTITY_REMOVE_FAILED",
      };
    }
  }

  return {
    success: true,
    data: {
      entityID: normalizedEntityID,
    },
  };
}

function listNativeWrecks() {
  return Object.values(readCollection(TABLE.WRECKS, "wrecks"))
    .filter(record => !isPendingMiningWreck(record))
    .sort((left, right) => Number(left.wreckID || 0) - Number(right.wreckID || 0));
}

function getNativeWreck(wreckID) {
  const collection = readCollectionRaw(TABLE.WRECKS, "wrecks");
  const record = collection[String(wreckID)] || null;
  return record && !isPendingMiningWreck(record) ? cloneValue(record) : null;
}

// Durable destination rows can exist before source cargo is removed. Until the
// handoff acknowledges both legs, ordinary inventory/scene readers must not
// expose those rows, including to a client that guesses their positive IDs.
function isPendingMiningWreck(record) {
  if (!record?.miningCargoTransferKey) return false;
  const transfer = database.read(TABLE.CARGO, `/miningTransfers/${record.miningCargoTransferKey}`);
  return !transfer.success || transfer.data?.status !== "completed";
}
function isPendingMiningWreckID(wreckID) {
  const result = database.read(TABLE.WRECKS, `/wrecks/${wreckID}`);
  return result.success && isPendingMiningWreck(result.data);
}

function upsertNativeWreck(wreckRecord, options = {}) {
  const wreckID = toPositiveInt(wreckRecord && wreckRecord.wreckID, 0);
  if (!wreckID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ID_REQUIRED",
    };
  }
  const scopeResolution = validateStoredEntityScopeMetadata(wreckRecord, {
    projectAirInstanceToDungeonSite: true,
  });
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  return writeCollectionRow(
    TABLE.WRECKS,
    "wrecks",
    wreckID,
    {
      ...wreckRecord,
      ...scopeResolution.data.metadata,
    },
    options,
  );
}

// Abandonment changes loot authority, so the native wreck record must become
// authoritative before its live ball is updated or broadcast. Durable wrecks
// cross a synchronous persistence boundary; transient wrecks still retain the
// marker in their service-owned record for scene rematerialization.
function setNativeWreckLootAbandoned(wreckID, abandoned = true) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  const wreckRecord = getNativeWreck(normalizedWreckID);
  if (!normalizedWreckID || !wreckRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }

  const nextLootAbandoned = abandoned === true;
  if ((wreckRecord.lootAbandoned === true) === nextLootAbandoned) {
    return {
      success: true,
      errorMsg: null,
      changed: false,
      durable: wreckRecord.transient !== true,
      data: wreckRecord,
    };
  }

  const transient = wreckRecord.transient === true;
  let writeResult = null;
  try {
    writeResult = upsertNativeWreck(
      {
        ...wreckRecord,
        lootAbandoned: nextLootAbandoned,
      },
      { transient },
    );
  } catch (error) {
    return {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() ||
        "NPC_NATIVE_WRECK_ABANDON_WRITE_FAILED",
    };
  }
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg:
        writeResult && writeResult.errorMsg ||
        "NPC_NATIVE_WRECK_ABANDON_WRITE_FAILED",
    };
  }

  if (transient) {
    return {
      success: true,
      errorMsg: null,
      changed: true,
      durable: false,
      data: getNativeWreck(normalizedWreckID),
    };
  }

  let flushResult = null;
  try {
    flushResult = database.flushTableSync(TABLE.WRECKS);
  } catch (error) {
    flushResult = {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() ||
        "NPC_NATIVE_WRECK_ABANDON_FLUSH_FAILED",
    };
  }
  if (flushResult && flushResult.success === true) {
    return {
      success: true,
      errorMsg: null,
      changed: true,
      durable: true,
      data: getNativeWreck(normalizedWreckID),
    };
  }

  // A failed durability boundary must not leave the in-memory authority ahead
  // of disk. Restore the prior row and make a best-effort synchronous rollback
  // before the caller considers changing the live entity.
  let rollbackWriteResult = null;
  let rollbackFlushResult = null;
  try {
    rollbackWriteResult = upsertNativeWreck(wreckRecord);
    if (rollbackWriteResult && rollbackWriteResult.success === true) {
      rollbackFlushResult = database.flushTableSync(TABLE.WRECKS);
    }
  } catch (_error) {
    rollbackWriteResult = rollbackWriteResult || { success: false };
    rollbackFlushResult = rollbackFlushResult || { success: false };
  }
  return {
    success: false,
    errorMsg:
      flushResult && flushResult.errorMsg ||
      "NPC_NATIVE_WRECK_ABANDON_FLUSH_FAILED",
    rollbackSuccess: Boolean(
      rollbackWriteResult &&
      rollbackWriteResult.success === true &&
      rollbackFlushResult &&
      rollbackFlushResult.success === true
    ),
  };
}

function removeNativeWreck(wreckID) {
  return removeCollectionRow(TABLE.WRECKS, "wrecks", wreckID);
}

function listNativeWreckItems() {
  return Object.values(readCollection(TABLE.WRECK_ITEMS, "items"))
    .filter(record => !isPendingMiningWreckID(record.wreckID))
    .sort((left, right) => Number(left.wreckItemID || 0) - Number(right.wreckItemID || 0));
}

function getNativeWreckItem(wreckItemID) {
  const collection = readCollectionRaw(TABLE.WRECK_ITEMS, "items");
  const record = collection[String(wreckItemID)] || null;
  return record && !isPendingMiningWreckID(record.wreckID) ? cloneValue(record) : null;
}

function listNativeWreckItemsForWreck(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  if (isPendingMiningWreckID(normalizedWreckID)) return [];
  return readCollectionRows(TABLE.WRECK_ITEMS, "items",
    (itemRecord) => toPositiveInt(itemRecord && itemRecord.wreckID, 0) === normalizedWreckID,
  ).sort((left, right) => Number(left.wreckItemID || 0) - Number(right.wreckItemID || 0));
}

function upsertNativeWreckItem(wreckItemRecord, options = {}) {
  const wreckItemID = toPositiveInt(wreckItemRecord && wreckItemRecord.wreckItemID, 0);
  if (!wreckItemID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ITEM_ID_REQUIRED",
    };
  }
  return writeCollectionRow(
    TABLE.WRECK_ITEMS,
    "items",
    wreckItemID,
    wreckItemRecord,
    options,
  );
}

function removeNativeWreckItem(wreckItemID) {
  return removeCollectionRow(TABLE.WRECK_ITEMS, "items", wreckItemID);
}

function flushNativeWreckItemsSync() {
  return database.flushTableSync(TABLE.WRECK_ITEMS);
}

function removeNativeWreckCascade(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  if (!normalizedWreckID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ID_REQUIRED",
    };
  }

  for (const itemRecord of listNativeWreckItemsForWreck(normalizedWreckID)) {
    const removeResult = removeNativeWreckItem(itemRecord.wreckItemID);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "NPC_NATIVE_WRECK_ITEM_REMOVE_FAILED",
      };
    }
  }
  if (getNativeWreck(normalizedWreckID)) {
    const wreckRemoveResult = removeNativeWreck(normalizedWreckID);
    if (!wreckRemoveResult || wreckRemoveResult.success !== true) {
      return wreckRemoveResult || {
        success: false,
        errorMsg: "NPC_NATIVE_WRECK_REMOVE_FAILED",
      };
    }
  }
  return {
    success: true,
    data: {
      wreckID: normalizedWreckID,
    },
  };
}

function buildNativeSlimModuleTuples(entityID) {
  return listNativeModulesForEntity(entityID)
    .map((moduleRecord) => ([
      toPositiveInt(moduleRecord && moduleRecord.moduleID, 0),
      toPositiveInt(moduleRecord && moduleRecord.typeID, 0),
      toPositiveInt(moduleRecord && moduleRecord.flagID, 0),
    ]))
    .filter((tuple) => tuple.every((value) => value > 0))
    .sort((left, right) => left[2] - right[2] || left[0] - right[0]);
}

function buildNativeFittedItems(entityID) {
  return listNativeModulesForEntity(entityID).map((moduleRecord) => ({
    itemID: toPositiveInt(moduleRecord && moduleRecord.moduleID, 0),
    ownerID: toPositiveInt(moduleRecord && moduleRecord.ownerID, 0),
    locationID: toPositiveInt(moduleRecord && moduleRecord.entityID, 0),
    flagID: toPositiveInt(moduleRecord && moduleRecord.flagID, 0),
    typeID: toPositiveInt(moduleRecord && moduleRecord.typeID, 0),
    groupID: toPositiveInt(moduleRecord && moduleRecord.groupID, 0),
    categoryID: toPositiveInt(moduleRecord && moduleRecord.categoryID, 0),
    itemName: String(moduleRecord && moduleRecord.itemName || ""),
    singleton: moduleRecord && moduleRecord.singleton === true,
    npcCapabilityTypeID: toPositiveInt(moduleRecord && moduleRecord.npcCapabilityTypeID, 0),
    moduleState: cloneValue(moduleRecord && moduleRecord.moduleState || {}),
  }));
}

function buildNativeCargoItems(entityID) {
  return listNativeCargoForEntity(entityID).map((cargoRecord) => ({
    itemID: toPositiveInt(cargoRecord && cargoRecord.cargoID, 0),
    ownerID: toPositiveInt(cargoRecord && cargoRecord.ownerID, 0),
    locationID: toPositiveInt(cargoRecord && cargoRecord.entityID, 0),
    moduleID: toPositiveInt(cargoRecord && cargoRecord.moduleID, 0),
    typeID: toPositiveInt(cargoRecord && cargoRecord.typeID, 0),
    groupID: toPositiveInt(cargoRecord && cargoRecord.groupID, 0),
    categoryID: toPositiveInt(cargoRecord && cargoRecord.categoryID, 0),
    itemName: String(cargoRecord && cargoRecord.itemName || ""),
    quantity: toPositiveInt(cargoRecord && cargoRecord.quantity, 0),
    singleton: Number(cargoRecord && cargoRecord.singleton) === 2
      ? 2 : cargoRecord && cargoRecord.singleton === true,
    flagID: toPositiveInt(cargoRecord && cargoRecord.flagID, 5),
    stacksize: cargoRecord && cargoRecord.singleton === true
      ? 1
      : toPositiveInt(cargoRecord && cargoRecord.quantity, 0),
    moduleState: cloneValue(cargoRecord && cargoRecord.moduleState || null),
    ...(cargoRecord && cargoRecord.blueprintState
      ? { blueprintState: cloneValue(cargoRecord.blueprintState) } : {}),
  }));
}

function buildNativeWreckInventoryItem(wreckID) {
  const wreckRecord = getNativeWreck(wreckID);
  if (!wreckRecord) {
    return null;
  }

  const position = cloneValue(wreckRecord.position || { x: 0, y: 0, z: 0 });
  const velocity = cloneValue(wreckRecord.velocity || { x: 0, y: 0, z: 0 });
  const direction = cloneValue(wreckRecord.direction || { x: 1, y: 0, z: 0 });
  const targetPoint = cloneValue(wreckRecord.targetPoint || position);
  const entityScopeMetadata = buildStoredEntityScopeMetadata(wreckRecord, {
    projectAirInstanceToDungeonSite: true,
  });
  const hasAbyssalScopeSignal = Boolean(
    String(wreckRecord.sceneKind || "").trim().toLowerCase() === "abyssal" ||
    String(wreckRecord.sceneKey || "").trim().startsWith("abyssal-run:") ||
    [
      "abyssalRunID",
      "evejsAbyssalInstanceID",
      "evejsAbyssalPocketInstanceID",
      "abyssalRoomIndex",
      "evejsAbyssalRoomIndex",
    ].some((fieldName) => Object.prototype.hasOwnProperty.call(wreckRecord, fieldName))
  );
  const interactionScope = hasAbyssalScopeSignal
    ? resolveEntityInteractionScope(wreckRecord)
    : null;
  if (interactionScope && !interactionScope.valid) {
    return null;
  }
  const completeScopeMetadata = hasAbyssalScopeSignal
    ? {
        ...entityScopeMetadata,
        ...buildChildEntityScopeMetadata(wreckRecord),
      }
    : entityScopeMetadata;

  return {
    itemID: toPositiveInt(wreckRecord.wreckID, 0),
    typeID: toPositiveInt(wreckRecord.typeID, 0),
    ownerID: toPositiveInt(wreckRecord.ownerID, 0),
    locationID: toPositiveInt(wreckRecord.systemID, 0),
    flagID: 0,
    quantity: -1,
    stacksize: 1,
    singleton: 1,
    groupID: toPositiveInt(wreckRecord.groupID, 0),
    categoryID: toPositiveInt(wreckRecord.categoryID, 0),
    itemName: String(wreckRecord.itemName || "Wreck"),
    customInfo: "",
    radius: Number(wreckRecord.radius || 0),
    spaceRadius: Number(wreckRecord.radius || 0),
    capacity: Number(wreckRecord.capacity || 0),
    spaceState: {
      position,
      velocity,
      direction,
      targetPoint,
      mode: String(wreckRecord.mode || "STOP"),
      speedFraction: Number(wreckRecord.speedFraction || 0),
      ...completeScopeMetadata,
    },
    ...completeScopeMetadata,
    conditionState: cloneValue(wreckRecord.conditionState || null),
    createdAtMs: Number(wreckRecord.createdAtMs || 0) || null,
    expiresAtMs: Number(wreckRecord.expiresAtMs || 0) || null,
    launcherID: toPositiveInt(wreckRecord.launcherID, 0) || null,
    dunRotation: Array.isArray(wreckRecord.dunRotation)
      ? cloneValue(wreckRecord.dunRotation)
      : null,
    transient: wreckRecord.transient === true,
  };
}

function buildNativeWreckContents(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  return listNativeWreckItemsForWreck(normalizedWreckID).map((itemRecord) => ({
    itemID: toPositiveInt(itemRecord && itemRecord.wreckItemID, 0),
    typeID: toPositiveInt(itemRecord && itemRecord.typeID, 0),
    ownerID: toPositiveInt(itemRecord && itemRecord.ownerID, 0),
    locationID: normalizedWreckID,
    flagID: toPositiveInt(itemRecord && itemRecord.flagID, 5),
    quantity:
      itemRecord && (itemRecord.singleton === true || Number(itemRecord.singleton) > 0)
        ? -(Number(itemRecord.singleton) === 2 ? 2 : 1)
        : toPositiveInt(itemRecord && itemRecord.quantity, 0),
    stacksize:
      itemRecord && (itemRecord.singleton === true || Number(itemRecord.singleton) > 0)
        ? 1
        : toPositiveInt(itemRecord && itemRecord.quantity, 0),
    singleton: Number(itemRecord && itemRecord.singleton) === 2
      ? 2 : itemRecord && (itemRecord.singleton === true || Number(itemRecord.singleton) === 1) ? 1 : 0,
    groupID: toPositiveInt(itemRecord && itemRecord.groupID, 0),
    categoryID: toPositiveInt(itemRecord && itemRecord.categoryID, 0),
    itemName: String(itemRecord && itemRecord.itemName || ""),
    customInfo: String(itemRecord && itemRecord.customInfo || ""),
    volume: Number(itemRecord && itemRecord.volume || 0),
    moduleState: cloneValue(itemRecord && itemRecord.moduleState || null),
  }));
}

module.exports = {
  _testing: Object.freeze({ invalidateControllerCache }),
  TABLE,
  TRANSIENT_ID_BASES,
  INVALID_PERSISTENT_IDENTITY,
  buildStoredEntityScopeMetadata,
  resolveStoredEntityScopeMetadata,
  validateStoredEntityScopeMetadata,
  allocateEntityID,
  allocateModuleID,
  allocateCargoID,
  allocateWreckID,
  allocateWreckItemID,
  listNativeEntities,
  listNativeEntitiesForSystem,
  getNativeEntity,
  upsertNativeEntity,
  removeNativeEntity,
  listNativeModulesForEntity,
  upsertNativeModule,
  removeNativeModule,
  listNativeCargoForEntity,
  getNativeCargo,
  upsertNativeCargo,
  removeNativeCargo,
  applyMiningCargoMutation,
  flushNativeCargoSync,
  miningCargoOwnerInstanceID,
  retirePreviousMiningCargoOwners,
  listMiningCargoRetirements,
  getMiningCargoWreckTransfer,
  commitMiningCargoWreckTransfer,
  reconcileMiningCargoWreckTransfers,
  listNativeControllers,
  listNativeControllersForSystem,
  getNativeController,
  upsertNativeController,
  removeNativeController,
  removeNativeEntityCascade,
  listNativeWrecks,
  getNativeWreck,
  upsertNativeWreck,
  setNativeWreckLootAbandoned,
  removeNativeWreck,
  listNativeWreckItems,
  getNativeWreckItem,
  listNativeWreckItemsForWreck,
  upsertNativeWreckItem,
  removeNativeWreckItem,
  flushNativeWreckItemsSync,
  removeNativeWreckCascade,
  buildNativeSlimModuleTuples,
  buildNativeFittedItems,
  buildNativeCargoItems,
  buildNativeWreckInventoryItem,
  buildNativeWreckContents,
};
