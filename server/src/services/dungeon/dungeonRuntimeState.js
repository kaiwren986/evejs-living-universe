"use strict";

const path = require("path");

// Phase 0 / 0.C: dungeon runtime state via an ownership-scoped repository.
const { isDeepStrictEqual } = require("util");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const gameStore = require(path.join(__dirname, "../../gameStore"));
const {
  isRetiredMissionTemplateIdentifier,
} = require(path.join(__dirname, "../../config/productionMissionPolicy"));
const {
  isRetiredOrdinaryEncounterMissionForAgent,
} = require(path.join(__dirname, "../agent/missionAuthority"));
const repo = createTableRepository("service:dungeon", { strict: true });

const DUNGEON_RUNTIME_TABLE = "dungeonRuntimeState";
const DUNGEON_RUNTIME_VERSION = 1;
const UNIVERSE_RECONCILE_META_VERSION = 1;

const ACTIVE_LIFECYCLE_STATES = new Set(["seeded", "active", "paused"]);
const TERMINAL_LIFECYCLE_STATES = new Set(["completed", "failed", "despawned"]);
const VALID_LIFECYCLE_STATES = new Set([
  ...ACTIVE_LIFECYCLE_STATES,
  ...TERMINAL_LIFECYCLE_STATES,
]);

let cache = null;
// Only reuse the cache as a persistence mirror after a fully successful write.
let persistedMirrorTrusted = false;

function readPersistedTable(table, pathArg) {
  if (repo && typeof repo.readPersisted === "function") {
    return repo.readPersisted(table, pathArg);
  }
  if (gameStore && typeof gameStore.readPersisted === "function") {
    return gameStore.readPersisted(table, pathArg);
  }
  return {
    success: false,
    errorMsg: "DUNGEON_DURABLE_READ_UNAVAILABLE",
    data: null,
  };
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toOptionalInt(value) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : null;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function isRetiredMissionTemplateID(templateID) {
  return isRetiredMissionTemplateIdentifier(templateID);
}

function isRetiredMissionIdentifier(value) {
  return isRetiredMissionTemplateIdentifier(value);
}

function isRetiredMissionInstanceRecord(instanceRecord = {}) {
  const metadata = instanceRecord && instanceRecord.metadata;
  if ([
    instanceRecord && instanceRecord.templateID,
    metadata && metadata.missionContentID,
    metadata && metadata.missionPresentationTemplateID,
    metadata && metadata.missionRuntimeTemplateID,
    metadata && metadata.missionTemplateID,
  ].some(isRetiredMissionIdentifier)) {
    return true;
  }
  if (!metadata || metadata.missionContentID == null) {
    return false;
  }
  return isRetiredOrdinaryEncounterMissionForAgent(
    metadata.missionAgentID,
    metadata.missionContentID,
    {
      contentID: metadata.missionContentID,
      dungeonID: instanceRecord.sourceDungeonID,
      dungeonTemplateID:
        metadata.missionRuntimeTemplateID || instanceRecord.templateID,
      missionTemplateID: metadata.missionPresentationTemplateID,
    },
  );
}

function listContentEntityItemIDs(instanceRecord = {}) {
  const refs = instanceRecord &&
    instanceRecord.spawnState &&
    instanceRecord.spawnState.contentEntityRefsByKey;
  return [...new Set(Object.values(
    refs && typeof refs === "object" && !Array.isArray(refs) ? refs : {},
  )
    .map((ref) => Math.max(0, toInt(ref && ref.itemID, 0)))
    .filter((itemID) => itemID > 0))];
}

function cleanupRetiredMissionInstanceInventory(table = {}) {
  const retiredItemIDs = new Set();
  const retainedItemIDs = new Set();
  for (const instanceRecord of Object.values(table.instancesByID || {})) {
    const target = isRetiredMissionInstanceRecord(instanceRecord)
      ? retiredItemIDs
      : retainedItemIDs;
    for (const itemID of listContentEntityItemIDs(instanceRecord)) {
      target.add(itemID);
    }
  }

  if (retiredItemIDs.size <= 0) {
    return;
  }
  const { removeInventoryItem } = require(path.join(
    __dirname,
    "../inventory/itemStore",
  ));
  for (const itemID of retiredItemIDs) {
    if (retainedItemIDs.has(itemID)) {
      continue;
    }
    removeInventoryItem(itemID, { removeContents: true });
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

// The table can exceed V8's string limit even when every stored row is small.
// Keep JSON clone semantics, but serialize each instance separately.
function cloneDungeonTableState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "instancesByID" || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      copy[key] = cloneValue(entry);
      continue;
    }
    const instances = {};
    for (const [instanceID, instance] of Object.entries(entry)) {
      instances[instanceID] = cloneValue(instance);
    }
    copy[key] = instances;
  }
  return copy;
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return cloneValue(value);
}

function normalizeNumberMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const numeric = Number(entry);
    if (Number.isFinite(numeric)) {
      normalized[String(key)] = numeric;
    }
  }
  return normalized;
}

function normalizeIDList(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
}

function normalizeStateName(value, fallback) {
  const normalized = normalizeLowerText(value, fallback);
  return normalized || fallback;
}

// Universe reconciliation historically accepted a family from three locations.
// Keep that precedence in one place so summaries can safely stand in for the
// full persisted instance on filtered no-op checks.
function resolveInstanceSpawnFamilyKey(instance = {}) {
  return normalizeText(
    instance && instance.metadata && instance.metadata.spawnFamilyKey,
    normalizeText(
      instance && instance.spawnState && instance.spawnState.spawnFamilyKey,
      instance && instance.siteFamily,
    ),
  ).toLowerCase();
}

function normalizeLifecycleState(value) {
  const normalized = normalizeLowerText(value, "seeded");
  return VALID_LIFECYCLE_STATES.has(normalized) ? normalized : "seeded";
}

function isActiveLifecycleState(lifecycleState) {
  return ACTIVE_LIFECYCLE_STATES.has(normalizeLifecycleState(lifecycleState));
}

function isUniversePersistentInstance(instance) {
  return Boolean(
    instance &&
    instance.runtimeFlags &&
    instance.runtimeFlags.universePersistent === true &&
    instance.runtimeFlags.universeSeeded === true
  );
}

function normalizePosition(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: Number(value[0]) || 0,
      y: Number(value[1]) || 0,
      z: Number(value[2]) || 0,
    };
  }

  if (value && typeof value === "object") {
    return {
      x: Number(value.x) || 0,
      y: Number(value.y) || 0,
      z: Number(value.z) || 0,
    };
  }

  return null;
}

function normalizeOwnership(value = {}) {
  return {
    visibilityScope: normalizeStateName(value.visibilityScope, "public"),
    characterID: toOptionalInt(value.characterID),
    corporationID: toOptionalInt(value.corporationID),
    fleetID: toOptionalInt(value.fleetID),
    missionOwnerCharacterID: toOptionalInt(value.missionOwnerCharacterID),
    sharedWithCharacterIDs: normalizeIDList(value.sharedWithCharacterIDs),
    metadata: normalizeJsonObject(value.metadata),
  };
}

function normalizeTimers(value = {}, lifecycleState = "seeded") {
  const createdAtMs = Math.max(0, toInt(value.createdAtMs, Date.now()));
  const activatedAtMs = Math.max(0, toInt(value.activatedAtMs, createdAtMs));
  const completedAtMs = Math.max(0, toInt(value.completedAtMs, 0));
  const failedAtMs = Math.max(0, toInt(value.failedAtMs, 0));
  const despawnAtMs = Math.max(0, toInt(value.despawnAtMs, 0));
  const expiresAtMs = Math.max(0, toInt(value.expiresAtMs, 0));

  let fallbackUpdatedAtMs = Math.max(createdAtMs, activatedAtMs);
  if (lifecycleState === "completed") {
    fallbackUpdatedAtMs = Math.max(fallbackUpdatedAtMs, completedAtMs);
  }
  if (lifecycleState === "failed") {
    fallbackUpdatedAtMs = Math.max(fallbackUpdatedAtMs, failedAtMs);
  }
  if (lifecycleState === "despawned") {
    fallbackUpdatedAtMs = Math.max(fallbackUpdatedAtMs, despawnAtMs);
  }

  return {
    createdAtMs,
    activatedAtMs,
    completedAtMs,
    failedAtMs,
    despawnAtMs,
    expiresAtMs,
    lastUpdatedAtMs: Math.max(0, toInt(value.lastUpdatedAtMs, fallbackUpdatedAtMs)),
  };
}

function normalizeRoomState(roomKey, value = {}) {
  return {
    roomKey,
    state: normalizeStateName(value.state, "pending"),
    stage: normalizeText(value.stage, "") || null,
    pocketID: toOptionalInt(value.pocketID),
    nodeGraphID: toOptionalInt(value.nodeGraphID),
    activatedAtMs: Math.max(0, toInt(value.activatedAtMs, 0)),
    completedAtMs: Math.max(0, toInt(value.completedAtMs, 0)),
    lastUpdatedAtMs: Math.max(0, toInt(value.lastUpdatedAtMs, 0)),
    spawnedEntityIDs: normalizeIDList(value.spawnedEntityIDs),
    counters: normalizeNumberMap(value.counters),
    metadata: normalizeJsonObject(value.metadata),
  };
}

function normalizeGateState(gateKey, value = {}) {
  return {
    gateKey,
    state: normalizeStateName(value.state, "idle"),
    usesCount: Math.max(0, toInt(value.usesCount, 0)),
    unlockedAtMs: Math.max(0, toInt(value.unlockedAtMs, 0)),
    lastUsedAtMs: Math.max(0, toInt(value.lastUsedAtMs, 0)),
    destinationRoomKey: normalizeText(value.destinationRoomKey, "") || null,
    allowedShipGroupIDs: normalizeIDList(value.allowedShipGroupIDs),
    allowedShipTypeIDs: normalizeIDList(value.allowedShipTypeIDs),
    metadata: normalizeJsonObject(value.metadata),
  };
}

function normalizeObjectiveState(value = {}) {
  return {
    state: normalizeStateName(value.state, "pending"),
    currentNodeID: toOptionalInt(value.currentNodeID),
    currentObjectiveID: toOptionalInt(value.currentObjectiveID),
    currentObjectiveKey: normalizeText(value.currentObjectiveKey, "") || null,
    currentObjectiveTypeID: toOptionalInt(value.currentObjectiveTypeID),
    completedObjectiveIDs: normalizeIDList(value.completedObjectiveIDs),
    completedNodeIDs: normalizeIDList(value.completedNodeIDs),
    completedAtMs: Math.max(0, toInt(value.completedAtMs, 0)),
    counters: normalizeNumberMap(value.counters),
    metadata: normalizeJsonObject(value.metadata),
  };
}

function normalizeInstanceRecord(record = {}) {
  const instanceID = Math.max(0, toInt(record.instanceID, 0));
  const lifecycleState = normalizeLifecycleState(record.lifecycleState);
  const roomStatesByKey = {};
  for (const [roomKey, roomState] of Object.entries(record.roomStatesByKey || {})) {
    const normalizedRoomKey = normalizeText(roomKey, "");
    if (!normalizedRoomKey) {
      continue;
    }
    roomStatesByKey[normalizedRoomKey] = normalizeRoomState(normalizedRoomKey, roomState);
  }

  const gateStatesByKey = {};
  for (const [gateKey, gateState] of Object.entries(record.gateStatesByKey || {})) {
    const normalizedGateKey = normalizeText(gateKey, "");
    if (!normalizedGateKey) {
      continue;
    }
    gateStatesByKey[normalizedGateKey] = normalizeGateState(normalizedGateKey, gateState);
  }

  const objectiveSatisfiedAtMs = Math.max(0, toInt(record.objectiveSatisfiedAtMs, 0));
  const objectiveSatisfiedReason = normalizeText(record.objectiveSatisfiedReason, "") || null;

  return {
    instanceID,
    templateID: normalizeText(record.templateID, ""),
    solarSystemID: Math.max(0, toInt(record.solarSystemID, 0)),
    siteKey: normalizeText(record.siteKey, "") || null,
    lifecycleState,
    lifecycleReason: normalizeText(record.lifecycleReason, "") || null,
    instanceScope: normalizeStateName(record.instanceScope, "shared"),
    siteFamily: normalizeLowerText(record.siteFamily, "unknown"),
    siteKind: normalizeLowerText(record.siteKind, "unknown"),
    siteOrigin: normalizeLowerText(record.siteOrigin, "unknown"),
    source: normalizeLowerText(record.source, "unknown"),
    sourceDungeonID: toOptionalInt(record.sourceDungeonID),
    archetypeID: toOptionalInt(record.archetypeID),
    factionID: toOptionalInt(record.factionID),
    difficulty: toOptionalInt(record.difficulty),
    entryObjectTypeID: toOptionalInt(record.entryObjectTypeID),
    dungeonNameID: toOptionalInt(record.dungeonNameID),
    position: normalizePosition(record.position),
    ownership: normalizeOwnership(record.ownership),
    timers: normalizeTimers(record.timers || {}, lifecycleState),
    roomStatesByKey,
    gateStatesByKey,
    objectiveState: normalizeObjectiveState(record.objectiveState),
    ...(objectiveSatisfiedAtMs > 0 ? { objectiveSatisfiedAtMs } : {}),
    ...(objectiveSatisfiedReason ? { objectiveSatisfiedReason } : {}),
    hazardState: normalizeJsonObject(record.hazardState),
    environmentState: normalizeJsonObject(record.environmentState),
    spawnState: normalizeJsonObject(record.spawnState),
    runtimeFlags: normalizeJsonObject(record.runtimeFlags),
    metadata: normalizeJsonObject(record.metadata),
  };
}

function normalizeUniverseReconcileMeta(value = {}) {
  const summary =
    value.summary && typeof value.summary === "object" && !Array.isArray(value.summary)
      ? cloneValue(value.summary)
      : {};
  return {
    version: Math.max(1, toInt(value.version, UNIVERSE_RECONCILE_META_VERSION)),
    descriptorKey: normalizeText(value.descriptorKey, ""),
    broadDescriptorKey: normalizeText(value.broadDescriptorKey, ""),
    miningDescriptorKey: normalizeText(value.miningDescriptorKey, ""),
    lastStartedAtMs: Math.max(0, toInt(value.lastStartedAtMs, 0)),
    lastCompletedAtMs: Math.max(0, toInt(value.lastCompletedAtMs, 0)),
    lastScope: normalizeText(value.lastScope, ""),
    lastReason: normalizeText(value.lastReason, ""),
    lastGeneratedIceDowntimeRestoreAtMs: Math.max(
      0,
      toInt(value.lastGeneratedIceDowntimeRestoreAtMs, 0),
    ),
    lastGeneratedIceDowntimeRestoreRunAtMs: Math.max(
      0,
      toInt(value.lastGeneratedIceDowntimeRestoreRunAtMs, 0),
    ),
    summary,
  };
}

function normalizeState(table = {}) {
  const instancesByID = {};
  for (const [instanceKey, instanceRecord] of Object.entries(table.instancesByID || {})) {
    if (isRetiredMissionInstanceRecord(instanceRecord)) {
      continue;
    }
    const normalized = normalizeInstanceRecord({
      ...instanceRecord,
      instanceID: toInt(
        instanceRecord && instanceRecord.instanceID,
        toInt(instanceKey, 0),
      ),
    });
    if (normalized.instanceID > 0 && normalized.templateID && normalized.solarSystemID > 0) {
      instancesByID[String(normalized.instanceID)] = normalized;
    }
  }

  return {
    version: DUNGEON_RUNTIME_VERSION,
    nextInstanceSequence: Math.max(1, toInt(table.nextInstanceSequence, 1)),
    instancesByID,
    universeReconcileMeta: normalizeUniverseReconcileMeta(table.universeReconcileMeta || {}),
  };
}

function buildInstanceSummary(instance) {
  return {
    instanceID: instance.instanceID,
    templateID: instance.templateID,
    solarSystemID: instance.solarSystemID,
    siteKey: instance.siteKey,
    lifecycleState: instance.lifecycleState,
    lifecycleReason: instance.lifecycleReason,
    instanceScope: instance.instanceScope,
    siteFamily: instance.siteFamily,
    // This scalar mirrors the precise metadata -> spawnState -> siteFamily
    // resolution used by universe reconciliation. Unlike the nested sources,
    // it is safe to use while inspecting only the per-system summary index.
    spawnFamilyKey: resolveInstanceSpawnFamilyKey(instance),
    siteKind: instance.siteKind,
    siteOrigin: instance.siteOrigin,
    source: instance.source,
    sourceDungeonID: instance.sourceDungeonID,
    archetypeID: instance.archetypeID,
    factionID: instance.factionID,
    difficulty: instance.difficulty,
    entryObjectTypeID: instance.entryObjectTypeID,
    dungeonNameID: instance.dungeonNameID,
    position: instance.position,
    // Shared by reference, like every other field here. The summary lives only in
    // this module's cache and every path that hands one to a caller clones it on
    // the way out, so the inner clones guarded against a mutation that cannot
    // happen: the cached instance is never written in place either.
    ownership: instance.ownership,
    timers: instance.timers,
    roomCount: Object.keys(instance.roomStatesByKey || {}).length,
    gateCount: Object.keys(instance.gateStatesByKey || {}).length,
    completedObjectiveCount: Array.isArray(instance.objectiveState && instance.objectiveState.completedObjectiveIDs)
      ? instance.objectiveState.completedObjectiveIDs.length
      : 0,
    runtimeFlags: instance.runtimeFlags,
    metadata: instance.metadata,
  };
}

function appendIndex(map, key, value) {
  if (!key && key !== 0) {
    return;
  }
  const normalizedKey = String(key);
  if (!map.has(normalizedKey)) {
    map.set(normalizedKey, []);
  }
  map.get(normalizedKey).push(value);
}

// `sourceState` is always already normalized: writeState and mutateState are the
// only callers that pass one, and both hand over the object they just ran through
// normalizeState. Normalizing again is a full pass over every instance for no
// change. Neither caller touches that object afterwards, and every read path out
// of the cache clones, so adopting it directly is safe.
function buildCache(sourceState = null) {
  let state;
  if (sourceState) {
    state = sourceState;
  } else {
    const result = repo.read(DUNGEON_RUNTIME_TABLE, "/");
    if (!result || result.success !== true) {
      const error = new Error(String(
        result && result.errorMsg || "DUNGEON_RUNTIME_STATE_READ_FAILED",
      ));
      error.code = "DUNGEON_RUNTIME_STATE_READ_FAILED";
      error.persistenceResult = result || null;
      throw error;
    }
    const persistedState = result.data && typeof result.data === "object"
      ? result.data
      : {};
    cleanupRetiredMissionInstanceInventory(persistedState);
    state = normalizeState(persistedState);
    const normalizationCommit = applyPersistedDiff(state);
    if (!normalizationCommit || normalizationCommit.success !== true) {
      const error = new Error(String(
        normalizationCommit && normalizationCommit.errorMsg ||
          "DUNGEON_RUNTIME_STATE_NORMALIZATION_PERSIST_FAILED",
      ));
      error.code = "DUNGEON_RUNTIME_STATE_NORMALIZATION_PERSIST_FAILED";
      error.persistenceResult = normalizationCommit || null;
      throw error;
    }
  }
  const instancesByID = new Map();
  const summariesByID = new Map();
  const instanceIDsBySystem = new Map();
  const activeInstanceIDsBySystem = new Map();
  const instanceIDsByTemplate = new Map();
  const instanceIDsByFamily = new Map();
  const instanceIDsByLifecycle = new Map();
  const instanceIDBySiteKey = new Map();
  const activeExpiringEntries = [];
  const activeUniversePersistentExpiringEntries = [];
  const universePersistentTerminalInstanceIDs = [];
  let nextActiveExpiryAtMs = 0;
  let nextUniversePersistentActiveExpiryAtMs = 0;

  for (const instance of Object.values(state.instancesByID || {})) {
    const summary = buildInstanceSummary(instance);
    instancesByID.set(instance.instanceID, instance);
    summariesByID.set(instance.instanceID, summary);

    appendIndex(instanceIDsBySystem, instance.solarSystemID, instance.instanceID);
    appendIndex(instanceIDsByTemplate, instance.templateID, instance.instanceID);
    appendIndex(instanceIDsByFamily, instance.siteFamily, instance.instanceID);
    appendIndex(instanceIDsByLifecycle, instance.lifecycleState, instance.instanceID);
    if (isActiveLifecycleState(instance.lifecycleState)) {
      appendIndex(activeInstanceIDsBySystem, instance.solarSystemID, instance.instanceID);
      const expiresAtMs = Math.max(0, toInt(instance && instance.timers && instance.timers.expiresAtMs, 0));
      if (expiresAtMs > 0) {
        const expiryEntry = {
          instanceID: instance.instanceID,
          expiresAtMs,
        };
        activeExpiringEntries.push(expiryEntry);
        nextActiveExpiryAtMs = nextActiveExpiryAtMs > 0
          ? Math.min(nextActiveExpiryAtMs, expiresAtMs)
          : expiresAtMs;
        if (isUniversePersistentInstance(instance)) {
          activeUniversePersistentExpiringEntries.push(expiryEntry);
          nextUniversePersistentActiveExpiryAtMs =
            nextUniversePersistentActiveExpiryAtMs > 0
              ? Math.min(nextUniversePersistentActiveExpiryAtMs, expiresAtMs)
              : expiresAtMs;
        }
      }
    } else if (isUniversePersistentInstance(instance)) {
      universePersistentTerminalInstanceIDs.push(instance.instanceID);
    }
    if (instance.siteKey) {
      const existing = instanceIDBySiteKey.get(instance.siteKey) || null;
      if (
        !existing ||
        !isActiveLifecycleState(summariesByID.get(existing) && summariesByID.get(existing).lifecycleState)
      ) {
        instanceIDBySiteKey.set(instance.siteKey, instance.instanceID);
      }
    }
  }

  for (const indexMap of [
    instanceIDsBySystem,
    activeInstanceIDsBySystem,
    instanceIDsByTemplate,
    instanceIDsByFamily,
    instanceIDsByLifecycle,
  ]) {
    for (const [key, values] of indexMap.entries()) {
      indexMap.set(key, [...new Set(values)].sort((left, right) => left - right));
    }
  }

  activeExpiringEntries.sort((left, right) => (
    left.expiresAtMs - right.expiresAtMs
  ) || (
    left.instanceID - right.instanceID
  ));
  activeUniversePersistentExpiringEntries.sort((left, right) => (
    left.expiresAtMs - right.expiresAtMs
  ) || (
    left.instanceID - right.instanceID
  ));
  universePersistentTerminalInstanceIDs.sort((left, right) => left - right);

  return {
    state,
    instancesByID,
    summariesByID,
    instanceIDsBySystem,
    activeInstanceIDsBySystem,
    instanceIDsByTemplate,
    instanceIDsByFamily,
    instanceIDsByLifecycle,
    instanceIDBySiteKey,
    activeExpiringEntries,
    activeUniversePersistentExpiringEntries,
    nextActiveExpiryAtMs,
    nextUniversePersistentActiveExpiryAtMs,
    universePersistentTerminalInstanceIDs,
  };
}

function ensureCache() {
  if (!cache) {
    cache = buildCache();
  }
  return cache;
}

function loadState() {
  return ensureCache().state;
}

// Read-only recovery admission probe. A no-debt RPC/tick must not initialize
// the dungeon owner: buildCache also normalizes durable rows and retires old
// mission inventory. Actual pending work still enters through loadState and
// getInstance so its normal authoritative hydration and validation run.
function peekState() {
  if (cache) return cache.state;
  const result = repo.read(DUNGEON_RUNTIME_TABLE, "/");
  if (!result?.success) {
    const error = new Error(result?.errorMsg || "DUNGEON_RUNTIME_STATE_READ_FAILED");
    error.code = "DUNGEON_RUNTIME_STATE_READ_FAILED";
    error.persistenceResult = result || null;
    throw error;
  }
  return result.data && typeof result.data === "object" ? result.data : {};
}

// Preserve per-row persistence for shared dungeon users. A normal
// mutation only updates the changed instance/scalar rows and lets gameStore's
// worker flush them asynchronously. Callers that explicitly request durability
// add one synchronous table flush, but never replace the table root or read the
// full table back on the event loop.
function readPersistedDiffPath(state, pathSuffix) {
  const segments = String(pathSuffix || "").split("/").filter(Boolean);
  let current = state;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: true, value: cloneValue(current) };
}

function rollbackPersistedDiff(currentState, pathSuffixes, options = {}) {
  const errors = [];
  const uniquePaths = [...new Set(pathSuffixes)].reverse();
  for (const pathSuffix of uniquePaths) {
    const previous = readPersistedDiffPath(currentState, pathSuffix);
    let result;
    try {
      result = previous.exists
        ? repo.write(
            DUNGEON_RUNTIME_TABLE,
            pathSuffix,
            cloneValue(previous.value),
            { force: true },
          )
        : repo.remove(DUNGEON_RUNTIME_TABLE, pathSuffix);
    } catch (error) {
      errors.push(`${pathSuffix}:${error && error.message || "ROLLBACK_THROWN"}`);
      continue;
    }
    if (!(
      result &&
      (result.success === true || (!previous.exists && result.errorMsg === "ENTRY_NOT_FOUND"))
    )) {
      errors.push(`${pathSuffix}:${result && result.errorMsg || "ROLLBACK_FAILED"}`);
    }
  }

  let flushResult = null;
  if (
    errors.length === 0 &&
    options.durable === true &&
    repo &&
    typeof repo.flushTableSync === "function"
  ) {
    try {
      flushResult = repo.flushTableSync(DUNGEON_RUNTIME_TABLE);
    } catch (error) {
      flushResult = {
        success: false,
        errorMsg: error && error.message || "ROLLBACK_FLUSH_THROWN",
      };
    }
    if (!flushResult || flushResult.success !== true) {
      errors.push(`flush:${flushResult && flushResult.errorMsg || "ROLLBACK_FLUSH_FAILED"}`);
    }
  }

  return {
    success: errors.length === 0,
    durable: Boolean(flushResult && flushResult.success === true),
    errors,
  };
}

function buildPersistedDiffFailure(
  errorMsg,
  cause,
  currentState,
  pathSuffixes,
  options = {},
) {
  const rollback = rollbackPersistedDiff(currentState, pathSuffixes, {
    durable: options.durable === true,
  });
  return {
    changed: 0,
    success: false,
    durable: false,
    errorMsg: String(errorMsg || "DUNGEON_RUNTIME_STATE_WRITE_FAILED"),
    cause: cause ? String(cause) : null,
    rollback,
  };
}

function applyPersistedDiff(nextState, options = {}, knownCurrentState = null) {
  const canUseMirror = persistedMirrorTrusted && knownCurrentState;
  persistedMirrorTrusted = false;
  const currentResult = canUseMirror
    ? { success: true, data: knownCurrentState }
    : repo.read(DUNGEON_RUNTIME_TABLE, "/");
  if (!currentResult || currentResult.success !== true) {
    return {
      changed: 0,
      success: false,
      durable: false,
      errorMsg: String(
        currentResult && currentResult.errorMsg || "DUNGEON_RUNTIME_STATE_READ_FAILED",
      ),
    };
  }
  const current = currentResult.data && typeof currentResult.data === "object"
    ? (canUseMirror ? currentResult.data : cloneDungeonTableState(currentResult.data))
    : {};
  const writes = [];
  const removes = [];
  const forceInstanceID = Math.max(0, toInt(options.forceInstanceID, 0));

  const prevInstances =
    current.instancesByID && typeof current.instancesByID === "object"
      ? current.instancesByID
      : {};
  const nextInstances = nextState.instancesByID || {};
  for (const instanceID of Object.keys(nextInstances)) {
    if (
      !isDeepStrictEqual(prevInstances[instanceID], nextInstances[instanceID]) ||
      (options.force === true && toInt(instanceID, 0) === forceInstanceID)
    ) {
      writes.push([`/instancesByID/${instanceID}`, nextInstances[instanceID]]);
    }
  }
  for (const instanceID of Object.keys(prevInstances)) {
    if (!Object.prototype.hasOwnProperty.call(nextInstances, instanceID)) {
      removes.push(`/instancesByID/${instanceID}`);
    }
  }

  for (const key of Object.keys(nextState)) {
    if (key === "instancesByID") {
      continue;
    }
    if (
      !isDeepStrictEqual(current[key], nextState[key]) ||
      (options.force === true && forceInstanceID <= 0)
    ) {
      writes.push([`/${key}`, nextState[key]]);
    }
  }
  for (const key of Object.keys(current)) {
    if (
      key !== "instancesByID" &&
      !Object.prototype.hasOwnProperty.call(nextState, key)
    ) {
      removes.push(`/${key}`);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(nextState, "instancesByID") &&
    !(current.instancesByID && typeof current.instancesByID === "object") &&
    writes.every(([pathSuffix]) => !pathSuffix.startsWith("/instancesByID/"))
  ) {
    writes.push(["/instancesByID", {}]);
  }

  const affectedPaths = [
    ...writes.map(([pathSuffix]) => pathSuffix),
    ...removes,
  ];

  for (const [pathSuffix, value] of writes) {
    let writeResult;
    try {
      writeResult = repo.write(
        DUNGEON_RUNTIME_TABLE,
        pathSuffix,
        cloneValue(value),
        {
          force: options.force === true && (
            forceInstanceID <= 0 ||
            pathSuffix === `/instancesByID/${forceInstanceID}`
          ),
        },
      );
    } catch (error) {
      return buildPersistedDiffFailure(
        "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
        error && error.message,
        current,
        affectedPaths,
        options,
      );
    }
    if (!writeResult || writeResult.success !== true) {
      return buildPersistedDiffFailure(
        writeResult && writeResult.errorMsg || "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
        writeResult && writeResult.cause,
        current,
        affectedPaths,
        options,
      );
    }
  }
  for (const pathSuffix of removes) {
    let removeResult;
    try {
      removeResult = repo.remove(DUNGEON_RUNTIME_TABLE, pathSuffix);
    } catch (error) {
      return buildPersistedDiffFailure(
        "DUNGEON_RUNTIME_STATE_REMOVE_FAILED",
        error && error.message,
        current,
        affectedPaths,
        options,
      );
    }
    if (!(
      removeResult &&
      (removeResult.success === true || removeResult.errorMsg === "ENTRY_NOT_FOUND")
    )) {
      return buildPersistedDiffFailure(
        removeResult && removeResult.errorMsg || "DUNGEON_RUNTIME_STATE_REMOVE_FAILED",
        null,
        current,
        affectedPaths,
        options,
      );
    }
  }

  const changed = writes.length + removes.length;
  if (options.durable !== true) {
    persistedMirrorTrusted = true;
    return {
      changed,
      success: true,
      durable: false,
      unchanged: changed === 0,
    };
  }
  if (!repo || typeof repo.flushTableSync !== "function") {
    return buildPersistedDiffFailure(
      "DUNGEON_DURABLE_COMMIT_UNAVAILABLE",
      null,
      current,
      affectedPaths,
      options,
    );
  }
  let flushResult;
  try {
    flushResult = repo.flushTableSync(DUNGEON_RUNTIME_TABLE);
  } catch (error) {
    return buildPersistedDiffFailure(
      "DUNGEON_RUNTIME_STATE_FLUSH_FAILED",
      error && error.message,
      current,
      affectedPaths,
      options,
    );
  }
  if (!flushResult || flushResult.success !== true) {
    return buildPersistedDiffFailure(
      flushResult && flushResult.errorMsg || "DUNGEON_RUNTIME_STATE_FLUSH_FAILED",
      null,
      current,
      affectedPaths,
      options,
    );
  }
  persistedMirrorTrusted = true;
  return {
    changed,
    success: true,
    durable: true,
    unchanged: changed === 0,
  };
}

function writeState(state, options = {}) {
  const normalized = normalizeState(state);
  const result = applyPersistedDiff(normalized, options, cache && cache.state);
  if (!result.success) {
    return false;
  }
  cache = buildCache(normalized);
  return true;
}

function addLazyStateData(result, state) {
  Object.defineProperty(result, "data", {
    enumerable: true,
    configurable: true,
    get() {
      const value = cloneDungeonTableState(state);
      Object.defineProperty(this, "data", {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return value;
    },
  });
  return result;
}

// Copy-on-write working view over the cache's instance table.
//
// mutateState used to hand the mutator a deep clone of the ENTIRE state, so that
// it could edit freely without corrupting the cache. That pays a full JSON round
// trip over every instance in order to change one field, and almost every mutator
// here touches exactly one record (`const target = table.instancesByID[id]`).
//
// Instead, expose each instance as an accessor that deep-clones on first touch and
// records the id. The mutator sees a plain object and keeps working unchanged --
// read, in-place mutation, assignment and `delete` all behave the same -- while the
// clone, the re-normalize and the diff afterwards become proportional to what it
// actually touched. A mutator that sweeps the table with Object.entries still
// materializes everything, which is correct, just not cheaper.
//
// Marking on *read* is deliberately conservative: a record that was only inspected
// is treated as dirty, because an in-place mutation is indistinguishable from a
// read once the getter has returned the object.
function createWorkingInstances(baseInstances, touched, originalGetters) {
  const working = {};
  for (const instanceID of Object.keys(baseInstances)) {
    let materialized = false;
    let value;
    const get = function getWorkingInstance() {
      if (!materialized) {
        materialized = true;
        touched.add(instanceID);
        value = cloneValue(baseInstances[instanceID]);
      }
      return value;
    };
    originalGetters.set(instanceID, get);
    Object.defineProperty(working, instanceID, {
      enumerable: true,
      configurable: true,
      get,
      set(nextValue) {
        materialized = true;
        touched.add(instanceID);
        value = nextValue;
      },
    });
  }
  return working;
}

// An id counts as untouched only if its slot is still the untriggered accessor we
// installed. `touched` alone is not enough: `delete table.instancesByID[id]`
// followed by a fresh assignment replaces the accessor with a plain data property
// without ever running the getter or the setter, and treating that as untouched
// would silently keep the record the mutator just replaced.
function isUntouchedWorkingSlot(workingInstances, instanceID, touched, originalGetters) {
  if (touched.has(instanceID)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(workingInstances, instanceID);
  return Boolean(
    descriptor &&
    typeof descriptor.get === "function" &&
    descriptor.get === originalGetters.get(instanceID),
  );
}

// normalizeState, but reusing the already-normalized record for every instance the
// mutator did not touch. Those are shared by reference with the previous state,
// which is also what makes the subsequent diff cheap: isDeepStrictEqual short
// circuits on identity, so an untouched instance costs one pointer comparison
// instead of a deep structural walk.
//
// The retired-record filter is still applied to every instance, touched or not: it
// is a cheap predicate over a handful of fields and its answer depends on config
// that can change independently of the table.
function normalizeWorkingState(working, workingInstances, baseInstances, touched, originalGetters) {
  const instancesByID = {};
  for (const instanceID of Object.keys(workingInstances)) {
    const untouched =
      Object.prototype.hasOwnProperty.call(baseInstances, instanceID) &&
      isUntouchedWorkingSlot(workingInstances, instanceID, touched, originalGetters);

    if (untouched) {
      const record = baseInstances[instanceID];
      if (isRetiredMissionInstanceRecord(record)) {
        continue;
      }
      instancesByID[String(record.instanceID)] = record;
      continue;
    }

    const record = workingInstances[instanceID];
    if (isRetiredMissionInstanceRecord(record)) {
      continue;
    }
    const normalized = normalizeInstanceRecord({
      ...record,
      instanceID: toInt(record && record.instanceID, toInt(instanceID, 0)),
    });
    if (normalized.instanceID > 0 && normalized.templateID && normalized.solarSystemID > 0) {
      instancesByID[String(normalized.instanceID)] = normalized;
    }
  }

  return {
    version: DUNGEON_RUNTIME_VERSION,
    nextInstanceSequence: Math.max(1, toInt(working.nextInstanceSequence, 1)),
    instancesByID,
    universeReconcileMeta: normalizeUniverseReconcileMeta(working.universeReconcileMeta || {}),
  };
}

function mutateState(mutator, options = {}) {
  const previousState = loadState();
  let normalizedNext;
  try {
    const baseInstances = previousState.instancesByID || {};
    const touched = new Set();
    const originalGetters = new Map();
    const workingInstances = createWorkingInstances(baseInstances, touched, originalGetters);

    // Top-level scalars are copied; universeReconcileMeta is small and is cloned so a
    // mutator editing it in place cannot reach into the cache.
    const working = {
      ...previousState,
      instancesByID: workingInstances,
      universeReconcileMeta: cloneValue(previousState.universeReconcileMeta || {}),
    };

    const next = mutator(working) || working;

    // The copy-on-write bookkeeping only describes `working`. A mutator that returns
    // a different object, or swaps the instance table out wholesale, invalidates it,
    // so fall back to normalizing whatever came back in full.
    normalizedNext = (next === working && next.instancesByID === workingInstances)
      ? normalizeWorkingState(working, workingInstances, baseInstances, touched, originalGetters)
      : normalizeState(next);

  } catch (error) {
    return addLazyStateData({
      success: false,
      skippedWrite: true,
      durable: false,
      errorMsg: "DUNGEON_RUNTIME_MUTATOR_FAILED",
      cause: error && error.message ? String(error.message) : "UNKNOWN",
    }, previousState);
  }

  const result = applyPersistedDiff(normalizedNext, options, previousState);
  if (!result.success) {
    const failure = addLazyStateData({
      success: false,
      skippedWrite: false,
      durable: false,
      errorMsg: result.errorMsg || "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
      cause: result.cause || null,
      rollback: result.rollback ? cloneValue(result.rollback) : null,
      attemptedData: cloneDungeonTableState(normalizedNext),
    }, previousState);
    return failure;
  }

  cache = buildCache(normalizedNext);
  return addLazyStateData({
    success: true,
    skippedWrite: result.changed === 0,
    durable: result.durable === true,
    unchanged: result.unchanged === true,
    changed: result.changed,
  }, normalizedNext);
}

function readPersistedStateSnapshot() {
  const result = readPersistedTable(DUNGEON_RUNTIME_TABLE, "/");
  if (!result || result.success !== true) {
    return {
      success: false,
      errorMsg: String(
        result && result.errorMsg || "DUNGEON_DURABLE_READ_FAILED",
      ),
      data: null,
    };
  }

  return {
    success: true,
    errorMsg: null,
    data: normalizeState(result.data),
  };
}

function readPersistedInstanceSnapshot(instanceID) {
  const numericInstanceID = Math.max(0, toInt(instanceID, 0));
  if (numericInstanceID <= 0) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_ID_REQUIRED",
      data: null,
    };
  }

  const instanceResult = readPersistedTable(
    DUNGEON_RUNTIME_TABLE,
    `/instancesByID/${numericInstanceID}`,
  );
  // An instance that is not in the durable table is a valid answer, not a read
  // failure: purged runs are the normal end state. Only a store error counts
  // as a failed durable read.
  if (
    instanceResult &&
    instanceResult.success !== true &&
    instanceResult.errorMsg === "ENTRY_NOT_FOUND"
  ) {
    return { success: true, errorMsg: null, data: null };
  }
  if (!instanceResult || instanceResult.success !== true) {
    return {
      success: false,
      errorMsg: String(
        instanceResult && instanceResult.errorMsg || "DUNGEON_DURABLE_READ_FAILED",
      ),
      data: null,
    };
  }
  const rawInstance = instanceResult.data;

  return {
    success: true,
    errorMsg: null,
    data: rawInstance
      ? normalizeInstanceRecord({
          ...rawInstance,
          instanceID: toInt(rawInstance.instanceID, numericInstanceID),
        })
      : null,
  };
}


function getNextInstanceSequence() {
  return loadState().nextInstanceSequence;
}

function getStateSnapshot() {
  return cloneDungeonTableState(loadState());
}

function getUniverseReconcileMeta() {
  return cloneValue(loadState().universeReconcileMeta || normalizeUniverseReconcileMeta());
}

function getInstanceSnapshot(instanceID) {
  const instance = ensureCache().instancesByID.get(Math.max(0, toInt(instanceID, 0)));
  return instance ? cloneValue(instance) : null;
}

// The live cache entry, NOT a copy. Only for callers that read a few fields and
// then drop the record: the caller must never mutate or retain what it gets.
//
// getInstanceSnapshot deep-clones through JSON on every call, which is the right
// contract for the callers that mutate the result and persist it. It is pure
// overhead on the session visibility sweep, which runs per dungeon-scoped entity,
// per session, per scene tick and reads five scalars before discarding the record.
// At the observed store size that clone is ~45us against ~0.02us for this read.
function getInstanceRef(instanceID) {
  return ensureCache().instancesByID.get(Math.max(0, toInt(instanceID, 0))) || null;
}

function getInstanceSummary(instanceID) {
  const summary = ensureCache().summariesByID.get(Math.max(0, toInt(instanceID, 0)));
  return summary ? cloneValue(summary) : null;
}

function filterSummaryList(instanceIDs, options = {}) {
  const normalizedLifecycleFilter = Array.isArray(options.lifecycleStates)
    ? [...new Set(options.lifecycleStates.map((entry) => normalizeLifecycleState(entry)))]
    : (
      options.lifecycleState
        ? [normalizeLifecycleState(options.lifecycleState)]
        : null
    );

  return (Array.isArray(instanceIDs) ? instanceIDs : [])
    .map((instanceID) => ensureCache().summariesByID.get(instanceID) || null)
    .filter(Boolean)
    .filter((summary) => {
      if (options.activeOnly === true && !isActiveLifecycleState(summary.lifecycleState)) {
        return false;
      }
      if (
        normalizedLifecycleFilter &&
        !normalizedLifecycleFilter.includes(summary.lifecycleState)
      ) {
        return false;
      }
      return true;
    })
    .map((summary) => cloneValue(summary));
}

function listInstanceSummariesBySystem(solarSystemID, options = {}) {
  const normalizedSystemID = Math.max(0, toInt(solarSystemID, 0));
  if (normalizedSystemID <= 0) {
    return [];
  }
  const indexMap = options.activeOnly === true
    ? ensureCache().activeInstanceIDsBySystem
    : ensureCache().instanceIDsBySystem;
  return filterSummaryList(indexMap.get(String(normalizedSystemID)) || [], options);
}

function listInstanceSummariesByTemplate(templateID, options = {}) {
  const normalizedTemplateID = normalizeText(templateID, "");
  if (!normalizedTemplateID) {
    return [];
  }
  return filterSummaryList(
    ensureCache().instanceIDsByTemplate.get(normalizedTemplateID) || [],
    options,
  );
}

function listInstanceSummariesByFamily(siteFamily, options = {}) {
  const normalizedFamily = normalizeLowerText(siteFamily, "");
  if (!normalizedFamily) {
    return [];
  }
  return filterSummaryList(
    ensureCache().instanceIDsByFamily.get(normalizedFamily) || [],
    options,
  );
}

function listInstanceSummariesByLifecycle(lifecycleState, options = {}) {
  const normalizedLifecycleState = normalizeLifecycleState(lifecycleState);
  return filterSummaryList(
    ensureCache().instanceIDsByLifecycle.get(normalizedLifecycleState) || [],
    {
      ...options,
      lifecycleState: normalizedLifecycleState,
    },
  );
}

function getNextActiveExpiryAtMs(options = {}) {
  const cacheState = ensureCache();
  if (options.universePersistentOnly === true) {
    return Math.max(
      0,
      toInt(cacheState.nextUniversePersistentActiveExpiryAtMs, 0),
    );
  }
  return Math.max(0, toInt(cacheState.nextActiveExpiryAtMs, 0));
}

function listExpiredActiveInstanceSummaries(nowMs, options = {}) {
  const normalizedNowMs = Math.max(0, toInt(nowMs, Date.now()));
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const targetedSystemIDs = hasSystemFilter
    ? new Set(normalizeIDList(options.systemIDs))
    : null;
  const cacheState = ensureCache();
  const expiringEntries = options.universePersistentOnly === true
    ? cacheState.activeUniversePersistentExpiringEntries
    : cacheState.activeExpiringEntries;
  const nextExpiryAtMs = getNextActiveExpiryAtMs({
    universePersistentOnly: options.universePersistentOnly === true,
  });
  if (
    expiringEntries.length <= 0 ||
    nextExpiryAtMs <= 0 ||
    nextExpiryAtMs > normalizedNowMs
  ) {
    return [];
  }

  const expired = [];
  for (const entry of expiringEntries) {
    if (entry.expiresAtMs > normalizedNowMs) {
      break;
    }
    const summary = cacheState.summariesByID.get(entry.instanceID) || null;
    const universePersistent = isUniversePersistentInstance(summary);
    if (
      hasSystemFilter &&
      (!summary || !targetedSystemIDs.has(toInt(summary.solarSystemID, 0)))
    ) {
      continue;
    }
    if (options.excludeUniversePersistent === true && universePersistent) {
      continue;
    }
    if (summary && isActiveLifecycleState(summary.lifecycleState)) {
      expired.push(cloneValue(summary));
    }
  }
  return expired;
}

function listUniversePersistentTerminalInstanceIDs() {
  return [...ensureCache().universePersistentTerminalInstanceIDs];
}

function findInstanceSummaryBySiteKey(siteKey) {
  const normalizedSiteKey = normalizeText(siteKey, "");
  if (!normalizedSiteKey) {
    return null;
  }
  const instanceID = ensureCache().instanceIDBySiteKey.get(normalizedSiteKey);
  if (!instanceID) {
    return null;
  }
  return getInstanceSummary(instanceID);
}

function clearRuntimeCache() {
  cache = null;
  persistedMirrorTrusted = false;
}

function writeUniverseReconcileMeta(meta = {}) {
  const existingMeta = getUniverseReconcileMeta();
  const normalizedMeta = normalizeUniverseReconcileMeta({
    ...existingMeta,
    ...meta,
  });
  const result = mutateState((table) => {
    table.universeReconcileMeta = normalizedMeta;
    return table;
  });
  if (!result || result.success !== true) {
    const error = new Error(String(
      result && result.errorMsg || "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
    ));
    error.code = "DUNGEON_RUNTIME_STATE_WRITE_FAILED";
    // Mutation results already own isolated snapshots, cloned one row at a time.
    error.persistenceResult = result || null;
    throw error;
  }
  return cloneValue(loadState().universeReconcileMeta || normalizedMeta);
}

function resetRuntimeStateForTests() {
  const reset = writeState({
    version: DUNGEON_RUNTIME_VERSION,
    nextInstanceSequence: 1,
    instancesByID: {},
    universeReconcileMeta: normalizeUniverseReconcileMeta(),
  }, { force: true });
  if (!reset) {
    throw new Error("DUNGEON_RUNTIME_TEST_RESET_PERSISTENCE_FAILED");
  }
}

module.exports = {
  ACTIVE_LIFECYCLE_STATES,
  DUNGEON_RUNTIME_TABLE,
  DUNGEON_RUNTIME_VERSION,
  TERMINAL_LIFECYCLE_STATES,
  UNIVERSE_RECONCILE_META_VERSION,
  clearRuntimeCache,
  findInstanceSummaryBySiteKey,
  getInstanceRef,
  getInstanceSnapshot,
  getInstanceSummary,
  getNextActiveExpiryAtMs,
  getNextInstanceSequence,
  getStateSnapshot,
  getUniverseReconcileMeta,
  readPersistedStateSnapshot,
  readPersistedInstanceSnapshot,
  isActiveLifecycleState,
  isUniversePersistentInstance,
  isRetiredMissionInstanceRecord,
  isRetiredMissionTemplateID,
  listExpiredActiveInstanceSummaries,
  listInstanceSummariesByLifecycle,
  listInstanceSummariesByFamily,
  listInstanceSummariesBySystem,
  listInstanceSummariesByTemplate,
  listUniversePersistentTerminalInstanceIDs,
  loadState,
  peekState,
  mutateState,
  normalizeInstanceRecord,
  normalizeUniverseReconcileMeta,
  resolveInstanceSpawnFamilyKey,
  resetRuntimeStateForTests,
  writeUniverseReconcileMeta,
  writeState,
};
