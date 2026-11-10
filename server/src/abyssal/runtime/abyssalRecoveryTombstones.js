"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Stateless operations; persistence, runtime and scheduling remain owned by injected ports.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function ensureAbyssalRecoveryTombstoneTable(ports, ) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    log,
  } = ports;
  try {
    if (database && typeof database.ensureTable === "function") {
      database.ensureTable(ABYSSAL_RECOVERY_TOMBSTONE_TABLE);
    }
  } catch (error) {
    log.warn(
      `[AbyssalRecovery] tombstone table unavailable reason=${error && error.message || "UNKNOWN"}`,
    );
  }
}

function writeAbyssalRecoveryTombstoneIndex(ports, indexName, key, tombstone) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    log,
    cloneValue,
  } = ports;
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return;
  }
  try {
    ensureAbyssalRecoveryTombstoneTable(ports, );
    database.write(
      ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
      `${indexName}/${normalizedKey}`,
      cloneValue(tombstone),
      { force: true },
    );
  } catch (error) {
    log.warn(
      `[AbyssalRecovery] tombstone write failed index=${indexName} key=${normalizedKey} ` +
        `reason=${error && error.message || "UNKNOWN"}`,
    );
  }
}

function readAbyssalRecoveryTombstoneIndex(ports, indexName, key) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    log,
    cloneValue,
  } = ports;
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) {
    return null;
  }
  try {
    ensureAbyssalRecoveryTombstoneTable(ports, );
    const result = database.read(ABYSSAL_RECOVERY_TOMBSTONE_TABLE, `${indexName}/${normalizedKey}`);
    return result && result.success === true && result.data
      ? cloneValue(result.data)
      : null;
  } catch (error) {
    log.warn(
      `[AbyssalRecovery] tombstone read failed index=${indexName} key=${normalizedKey} ` +
        `reason=${error && error.message || "UNKNOWN"}`,
    );
    return null;
  }
}

function normalizeAbyssalRecoveryOriginAttempts(ports, attempts) {
  return (Array.isArray(attempts) ? attempts : []).slice(0, 3).map((attempt) => ({
    source: normalizeText(attempt && attempt.source, "unknown"),
    status: normalizeText(attempt && attempt.status, "unknown"),
    systemID: toInt(attempt && attempt.systemID, 0) || null,
  }));
}

function normalizeAbyssalRecoveryTombstone(ports,
  tombstone,
  deps = ports.getDependencies(),
) {
  const {
    isAbyssalHostLocationID,
    ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
    getObjectPosition,
    ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS,
  } = ports;
  if (!tombstone || typeof tombstone !== "object") {
    return null;
  }
  const candidateSourceSolarSystemID = toInt(tombstone.sourceSolarSystemID, 0);
  const sourceSolarSystemID =
    candidateSourceSolarSystemID > 0 &&
    !isAbyssalHostLocationID(candidateSourceSolarSystemID, deps)
      ? candidateSourceSolarSystemID
      : null;
  const originResolved = Boolean(
    tombstone.originResolved !== false && sourceSolarSystemID,
  );
  const destinationSolarSystemID = toInt(
    tombstone.destinationSolarSystemID,
    originResolved ? sourceSolarSystemID : 0,
  ) || null;
  return {
    schemaVersion: 2,
    idempotencyKey: normalizeText(tombstone.idempotencyKey, ""),
    reason: normalizeText(tombstone.reason, ""),
    characterID: toInt(tombstone.characterID, 0),
    shipID: toInt(tombstone.shipID, 0),
    runID: toInt(tombstone.runID, 0),
    traceID: toInt(tombstone.traceID || tombstone.traceItemID, 0),
    hostLocationID: toInt(tombstone.hostLocationID, 0),
    sourceSolarSystemID: originResolved ? sourceSolarSystemID : null,
    originResolved,
    originResolutionReason: originResolved
      ? ""
      : normalizeText(
          tombstone.originResolutionReason,
          ABYSSAL_RECOVERY_ORIGIN_UNRESOLVED,
        ),
    recoveryTargetSource: normalizeText(
      tombstone.recoveryTargetSource,
      originResolved ? "authoritativeSource" : "",
    ),
    destinationSolarSystemID,
    originAuthorityAttempts: normalizeAbyssalRecoveryOriginAttempts(ports,
      tombstone.originAuthorityAttempts,
    ),
    returnPosition: getObjectPosition(tombstone.returnPosition) || { x: 0, y: 0, z: 0 },
    evacuationState: normalizeText(tombstone.evacuationState, "pending"),
    failureReason: normalizeText(tombstone.failureReason, ""),
    moveCommittedAtMs: toInt(tombstone.moveCommittedAtMs, 0),
    cleanupCompletedAtMs: toInt(tombstone.cleanupCompletedAtMs, 0),
    createdAt: toInt(tombstone.createdAt, Date.now()),
    completedAt: toInt(tombstone.completedAt, 0),
    expiresAt: toInt(
      tombstone.expiresAt,
      toInt(tombstone.createdAt, Date.now()) + ABYSSAL_RECOVERY_TOMBSTONE_RETENTION_MS,
    ),
  };
}

function rememberAbyssalRecoveryTombstone(ports, tombstone) {
  const {
    cloneValue,
    schedulePlaceholderPocketMaintenance,
    registerTombstone,
  } = ports;
  const normalized = normalizeAbyssalRecoveryTombstone(ports, tombstone);
  if (!normalized) {
    return null;
  }
  registerTombstone(normalized);
  if (normalized.characterID > 0) {
    writeAbyssalRecoveryTombstoneIndex(ports, "byCharacterID", normalized.characterID, normalized);
  }
  if (normalized.shipID > 0) {
    writeAbyssalRecoveryTombstoneIndex(ports, "byShipID", normalized.shipID, normalized);
  }
  if (normalized.hostLocationID > 0) {
    writeAbyssalRecoveryTombstoneIndex(ports, "byHostLocationID", normalized.hostLocationID, normalized);
  }
  schedulePlaceholderPocketMaintenance(ports.getDependencies());
  return cloneValue(normalized);
}

function findAbyssalRecoveryTombstone(ports, context = {}) {
  const {
    cloneValue,
    findTombstoneCandidates,
  } = ports;
  const characterID = toInt(context.characterID, 0);
  const shipID = toInt(context.shipID, 0);
  const hostLocationID = toInt(context.hostLocationID || context.systemID, 0);
  const nowMs = Math.max(0, toInt(context.nowMs, Date.now()));
  const candidates = [
    ...findTombstoneCandidates({
      characterID,
      shipID,
      hostLocationID,
    }),
    characterID > 0 ? readAbyssalRecoveryTombstoneIndex(ports, "byCharacterID", characterID) : null,
    shipID > 0 ? readAbyssalRecoveryTombstoneIndex(ports, "byShipID", shipID) : null,
    hostLocationID > 0 ? readAbyssalRecoveryTombstoneIndex(ports, "byHostLocationID", hostLocationID) : null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const normalizedCandidate = normalizeAbyssalRecoveryTombstone(ports, candidate);
    if (!normalizedCandidate) {
      continue;
    }
    if (
      toInt(normalizedCandidate.expiresAt, nowMs + 1) > 0 &&
      toInt(normalizedCandidate.expiresAt, 0) <= nowMs
    ) {
      continue;
    }
    if (
      (characterID > 0 && toInt(normalizedCandidate.characterID, 0) !== characterID) ||
      (shipID > 0 && toInt(normalizedCandidate.shipID, 0) !== shipID) ||
      (hostLocationID > 0 && toInt(normalizedCandidate.hostLocationID, 0) !== hostLocationID)
    ) {
      continue;
    }
    return cloneValue(normalizedCandidate);
  }
  return null;
}

function updateAbyssalRecoveryTombstoneState(ports, tombstone, evacuationState, patch = {}) {
  if (!tombstone || typeof tombstone !== "object") {
    return null;
  }
  return rememberAbyssalRecoveryTombstone(ports, {
    ...tombstone,
    ...patch,
    evacuationState,
    completedAt:
      evacuationState === "complete" || evacuationState === "failed"
        ? toInt(patch.completedAt, Date.now())
        : toInt(tombstone.completedAt, 0),
  });
}

function getAbyssalRecoveryTombstoneIdentity(ports, tombstone) {
  if (!tombstone || typeof tombstone !== "object") {
    return "";
  }
  return JSON.stringify([
    normalizeText(tombstone.idempotencyKey, ""),
    toInt(tombstone.runID, 0),
    toInt(tombstone.characterID, 0),
    toInt(tombstone.shipID, 0),
    toInt(tombstone.hostLocationID, 0),
    toInt(tombstone.createdAt, 0),
  ]);
}

function hasPendingAbyssalParticipantDestructionReceiptForRun(ports, instanceID) {
  const {
    hasParticipantDestructionReceiptForRun,
  } = ports;
  const numericInstanceID = toInt(instanceID, 0);
  if (numericInstanceID <= 0) {
    return false;
  }
  return hasParticipantDestructionReceiptForRun(
    numericInstanceID,
  );
}

function abyssalRecoveryTombstoneIsEvictable(ports,
  tombstone,
  nowMs,
  deps = ports.getDependencies(),
) {
  const {
    hasActiveRun,
    hasPersistenceFailure,
    hasMutationBatch,
    hasRecoveryRetryState,
    getTransitionHandle,
    getHostReservation,
  } = ports;
  if (!tombstone || typeof tombstone !== "object") {
    return false;
  }
  const effectiveNowMs = Math.max(0, toInt(nowMs, 0));
  const expiresAt = toInt(tombstone.expiresAt, 0);
  if (
    expiresAt <= 0 ||
    expiresAt > effectiveNowMs ||
    normalizeText(tombstone.evacuationState, "").toLowerCase() !== "complete" ||
    normalizeText(tombstone.failureReason, "")
  ) {
    return false;
  }

  const instanceID = toInt(tombstone.runID, 0);
  if (instanceID <= 0) {
    return true;
  }
  if (
    hasActiveRun(instanceID) ||
    hasPersistenceFailure(instanceID) ||
    hasMutationBatch(instanceID) ||
    hasRecoveryRetryState(instanceID) ||
    Boolean(getTransitionHandle(instanceID)) ||
    hasPendingAbyssalParticipantDestructionReceiptForRun(ports, instanceID) ||
    getHostReservation(instanceID)
  ) {
    return false;
  }
  if (
    !deps ||
    !deps.dungeonRuntime ||
    typeof deps.dungeonRuntime.getPersistedInstance !== "function"
  ) {
    return false;
  }
  // A run that is still loaded in the dungeon runtime cache is not gone, and
  // that answer costs nothing. The durable read below loads the whole dungeon
  // table, so it is only worth paying once, to confirm that a run the cache no
  // longer holds is really purged before the tombstone is dropped.
  if (
    typeof deps.dungeonRuntime.getInstanceRef === "function" &&
    deps.dungeonRuntime.getInstanceRef(instanceID)
  ) {
    return false;
  }
  try {
    return !deps.dungeonRuntime.getPersistedInstance(instanceID);
  } catch (_error) {
    // ignored: an unreadable durable record does not prove the run is gone, so the tombstone stays (false)
    return false;
  }
}

function readAbyssalRecoveryTombstoneTableState(ports, ) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
  } = ports;
  try {
    ensureAbyssalRecoveryTombstoneTable(ports, );
    const result = database.read(ABYSSAL_RECOVERY_TOMBSTONE_TABLE, "/");
    return result && result.success === true && result.data &&
      typeof result.data === "object"
      ? result.data
      : {};
  } catch (_error) {
    // ignored: an unreadable table gives no durable tombstones this pass; the in-memory ones still count
    return {};
  }
}

function hasAbyssalRecoveryTombstoneBacklog(ports, ) {
  const {
    RECOVERY_TOMBSTONE_INDEX_DEFINITIONS,
    hasTombstoneEntries,
  } = ports;
  if (hasTombstoneEntries()) {
    return true;
  }
  const persistentState = readAbyssalRecoveryTombstoneTableState(ports, );
  for (const { indexName } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
    const index = persistentState[indexName];
    if (index && typeof index === "object") {
      for (const _key in index) {
        return true;
      }
    }
  }
  return false;
}

function* iterateAbyssalRecoveryTombstones(ports, ) {
  const {
    RECOVERY_TOMBSTONE_INDEX_DEFINITIONS,
    iterateTombstoneValues,
  } = ports;
  yield* iterateTombstoneValues();
  const persistentState = readAbyssalRecoveryTombstoneTableState(ports, );
  for (const { indexName } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
    const index = persistentState[indexName];
    if (!index || typeof index !== "object") {
      continue;
    }
    for (const key in index) {
      yield index[key];
    }
  }
}

function deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes(ports, tombstone) {
  const {
    deleteMatchingTombstones,
  } = ports;
  return deleteMatchingTombstones(
    tombstone,
    getAbyssalRecoveryTombstoneIdentity.bind(null, ports),
  );
}

function deleteNestedTablePaths(ports, source, paths) {
  const {
    cloneValue,
  } = ports;
  const next = cloneValue(source && typeof source === "object" ? source : {});
  for (const rawPath of paths) {
    const segments = String(rawPath || "")
      .split("/")
      .filter(Boolean);
    if (segments.length <= 0) {
      continue;
    }
    let parent = next;
    for (let index = 0; index < segments.length - 1; index += 1) {
      parent = parent && typeof parent === "object"
        ? parent[segments[index]]
        : null;
      if (!parent || typeof parent !== "object") {
        break;
      }
    }
    if (parent && typeof parent === "object") {
      delete parent[segments[segments.length - 1]];
    }
  }
  return next;
}

function hasNestedTablePath(ports, source, rawPath) {
  const segments = String(rawPath || "")
    .split("/")
    .filter(Boolean);
  let current = source;
  for (const segment of segments) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return false;
    }
    current = current[segment];
  }
  return segments.length > 0;
}

function commitAbyssalRecoveryTombstonePathDeletes(ports, paths) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
  } = ports;
  const uniquePaths = [...new Set(
    (Array.isArray(paths) ? paths : []).map((pathKey) => String(pathKey || "")),
  )].filter(Boolean);
  if (uniquePaths.length <= 0) {
    return { success: true, durable: true, unchanged: true };
  }

  const cachedResult = database.read(ABYSSAL_RECOVERY_TOMBSTONE_TABLE, "/");
  const cachedState =
    cachedResult && cachedResult.success === true &&
    cachedResult.data && typeof cachedResult.data === "object"
      ? cachedResult.data
      : {};
  const nextState = deleteNestedTablePaths(ports, cachedState, uniquePaths);
  const writeResult = database.write(
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    "/",
    nextState,
    { force: true, knownChangedPaths: uniquePaths },
  );
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      durable: false,
      errorMsg: normalizeText(
        writeResult && writeResult.errorMsg,
        "ABYSSAL_RECOVERY_TOMBSTONE_DELETE_FAILED",
      ),
    };
  }

  const flushResult = database.flushTableSync(
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
  );
  const readbackResult = typeof database.readPersisted === "function"
    ? database.readPersisted(ABYSSAL_RECOVERY_TOMBSTONE_TABLE, "/")
    : null;
  const durableState =
    readbackResult && readbackResult.success === true &&
    readbackResult.data && typeof readbackResult.data === "object"
      ? readbackResult.data
      : null;
  const deletesAreDurable = Boolean(
    durableState &&
    uniquePaths.every((pathKey) => !hasNestedTablePath(ports, durableState, pathKey)),
  );
  if (deletesAreDurable) {
    return {
      success: true,
      durable: true,
      unchanged: false,
      deleted: uniquePaths.length,
    };
  }

  // A failed or ambiguous flush must not leave process cache ahead of the
  // durable snapshot while the in-memory tombstone indexes remain resident.
  database.write(
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    "/",
    durableState || cachedState,
    { force: true, knownChangedPaths: uniquePaths },
  );
  return {
    success: false,
    durable: false,
    errorMsg: normalizeText(
      flushResult && flushResult.errorMsg,
      readbackResult && readbackResult.errorMsg ||
        "ABYSSAL_RECOVERY_TOMBSTONE_DELETE_FAILED",
    ),
  };
}

function commitAbyssalRecoveryTombstoneEvictions(ports, candidates, nowMs) {
  const {
    log,
    RECOVERY_TOMBSTONE_INDEX_DEFINITIONS,
    ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS,
    hasMatchingTombstone,
    recordTombstoneEvictionFailure,
  } = ports;
  if (!Array.isArray(candidates) || candidates.length <= 0) {
    return { success: true, evicted: 0, durableDeletes: 0 };
  }
  const durablePaths = [];
  const residentIdentities = new Set();
  for (const candidate of candidates) {
    const identity = getAbyssalRecoveryTombstoneIdentity(ports, candidate);
    for (const { indexName, keyField } of RECOVERY_TOMBSTONE_INDEX_DEFINITIONS) {
      const key = toInt(candidate && candidate[keyField], 0);
      if (
        key > 0 &&
        hasMatchingTombstone(
          indexName,
          key,
          identity,
          getAbyssalRecoveryTombstoneIdentity.bind(null, ports),
        )
      ) {
        residentIdentities.add(identity);
      }
      const durableSibling = key > 0
        ? readAbyssalRecoveryTombstoneIndex(ports, indexName, key)
        : null;
      if (
        key > 0 &&
        getAbyssalRecoveryTombstoneIdentity(ports, durableSibling) === identity
      ) {
        durablePaths.push(`/${indexName}/${key}`);
        residentIdentities.add(identity);
      }
    }
  }

  let commitResult = { success: true, durable: true, unchanged: true };
  if (durablePaths.length > 0) {
    try {
      commitResult = commitAbyssalRecoveryTombstonePathDeletes(ports, durablePaths);
    } catch (error) {
      commitResult = {
        success: false,
        durable: false,
        errorMsg: error && error.message || "ABYSSAL_RECOVERY_TOMBSTONE_DELETE_FAILED",
      };
    }
  }
  if (!commitResult || commitResult.success !== true || commitResult.durable !== true) {
    if (
      recordTombstoneEvictionFailure(
        nowMs,
        ABYSSAL_RECOVERY_TOMBSTONE_FAILURE_LOG_INTERVAL_MS,
      )
    ) {
      log.warn(
        `[AbyssalRecovery] tombstone eviction durable delete failed ` +
          `batch=${candidates.length} indexes=${durablePaths.length} ` +
          `reason=${normalizeText(commitResult && commitResult.errorMsg, "UNKNOWN")}`,
      );
    }
    return {
      success: false,
      evicted: 0,
      durableDeletes: 0,
      errorMsg: normalizeText(
        commitResult && commitResult.errorMsg,
        "ABYSSAL_RECOVERY_TOMBSTONE_DELETE_FAILED",
      ),
    };
  }

  for (const candidate of candidates) {
    deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes(ports, candidate);
  }
  return {
    success: true,
    evicted: residentIdentities.size,
    durableDeletes: durablePaths.length,
  };
}

function runAbyssalRecoveryTombstoneMaintenance(ports,
  nowMs = null,
  deps = ports.getDependencies(),
) {
  const {
    resolveEffectiveAbyssalMaintenanceNowMs,
    ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS,
    ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS,
    nextTombstoneScanEntry,
    finishTombstoneScan,
    recordTombstoneMaintenancePass,
    hasTombstoneScanInProgress,
  } = ports;
  const effectiveNowMs = resolveEffectiveAbyssalMaintenanceNowMs(nowMs, deps);
  const eligibleByIdentity = new Map();
  let scanned = 0;
  let expired = 0;
  let retainedExpired = 0;
  let scanComplete = false;
  while (scanned < ABYSSAL_RECOVERY_TOMBSTONE_MAX_SCAN_PER_PASS) {
    const next = nextTombstoneScanEntry(
      () => iterateAbyssalRecoveryTombstones(ports, ),
    );
    if (next.done) {
      finishTombstoneScan();
      scanComplete = true;
      break;
    }
    scanned += 1;
    const tombstone = next.value;
    const expiresAt = toInt(tombstone && tombstone.expiresAt, 0);
    if (expiresAt <= 0 || expiresAt > effectiveNowMs) {
      continue;
    }
    expired += 1;
    if (!abyssalRecoveryTombstoneIsEvictable(ports, tombstone, effectiveNowMs, deps)) {
      retainedExpired += 1;
      continue;
    }
    const identity = getAbyssalRecoveryTombstoneIdentity(ports, tombstone);
    if (identity && !eligibleByIdentity.has(identity)) {
      eligibleByIdentity.set(identity, tombstone);
      if (eligibleByIdentity.size >= ABYSSAL_RECOVERY_TOMBSTONE_MAX_EVICTIONS_PER_PASS) {
        break;
      }
    }
  }
  const candidates = [...eligibleByIdentity.values()];
  const commitResult = commitAbyssalRecoveryTombstoneEvictions(ports,
    candidates,
    effectiveNowMs,
  );
  recordTombstoneMaintenancePass({
    scanned,
    expired,
    eligible: candidates.length,
    evicted: toInt(commitResult.evicted, 0),
    retainedExpired,
  });
  return {
    ...commitResult,
    scanned,
    expired,
    eligible: candidates.length,
    retainedExpired,
    scanComplete,
    scanInProgress: hasTombstoneScanInProgress(),
  };
}

function getAbyssalRecoveryTombstoneDiagnosticsForTests(ports, ) {
  const {
    database,
    ABYSSAL_RECOVERY_TOMBSTONE_TABLE,
    cloneValue,
    getTombstoneDiagnostics,
  } = ports;
  let persistentState = {};
  try {
    ensureAbyssalRecoveryTombstoneTable(ports, );
    const result = database.read(ABYSSAL_RECOVERY_TOMBSTONE_TABLE, "/");
    persistentState = result && result.success === true && result.data &&
      typeof result.data === "object"
      ? result.data
      : {};
  } catch (_error) {
    persistentState = {};
  }
  const countEntries = (value) => value && typeof value === "object"
    ? Object.keys(value).length
    : 0;
  const storeDiagnostics = getTombstoneDiagnostics();
  return {
    memory: storeDiagnostics.memory,
    persistent: {
      byCharacterID: countEntries(persistentState.byCharacterID),
      byShipID: countEntries(persistentState.byShipID),
      byHostLocationID: countEntries(persistentState.byHostLocationID),
    },
    scanInProgress: storeDiagnostics.scanInProgress,
    metrics: cloneValue(storeDiagnostics.metrics),
  };
}

function createAbyssalRecoveryTombstoneOperations(ports) {
  return {
    ensureAbyssalRecoveryTombstoneTable: ensureAbyssalRecoveryTombstoneTable.bind(null, ports),
    writeAbyssalRecoveryTombstoneIndex: writeAbyssalRecoveryTombstoneIndex.bind(null, ports),
    readAbyssalRecoveryTombstoneIndex: readAbyssalRecoveryTombstoneIndex.bind(null, ports),
    normalizeAbyssalRecoveryOriginAttempts: normalizeAbyssalRecoveryOriginAttempts.bind(null, ports),
    normalizeAbyssalRecoveryTombstone: normalizeAbyssalRecoveryTombstone.bind(null, ports),
    rememberAbyssalRecoveryTombstone: rememberAbyssalRecoveryTombstone.bind(null, ports),
    findAbyssalRecoveryTombstone: findAbyssalRecoveryTombstone.bind(null, ports),
    updateAbyssalRecoveryTombstoneState: updateAbyssalRecoveryTombstoneState.bind(null, ports),
    getAbyssalRecoveryTombstoneIdentity: getAbyssalRecoveryTombstoneIdentity.bind(null, ports),
    hasPendingAbyssalParticipantDestructionReceiptForRun: hasPendingAbyssalParticipantDestructionReceiptForRun.bind(null, ports),
    abyssalRecoveryTombstoneIsEvictable: abyssalRecoveryTombstoneIsEvictable.bind(null, ports),
    readAbyssalRecoveryTombstoneTableState: readAbyssalRecoveryTombstoneTableState.bind(null, ports),
    hasAbyssalRecoveryTombstoneBacklog: hasAbyssalRecoveryTombstoneBacklog.bind(null, ports),
    iterateAbyssalRecoveryTombstones: iterateAbyssalRecoveryTombstones.bind(null, ports),
    deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes: deleteMatchingAbyssalRecoveryTombstoneMemoryIndexes.bind(null, ports),
    deleteNestedTablePaths: deleteNestedTablePaths.bind(null, ports),
    hasNestedTablePath: hasNestedTablePath.bind(null, ports),
    commitAbyssalRecoveryTombstonePathDeletes: commitAbyssalRecoveryTombstonePathDeletes.bind(null, ports),
    commitAbyssalRecoveryTombstoneEvictions: commitAbyssalRecoveryTombstoneEvictions.bind(null, ports),
    runAbyssalRecoveryTombstoneMaintenance: runAbyssalRecoveryTombstoneMaintenance.bind(null, ports),
    getAbyssalRecoveryTombstoneDiagnosticsForTests: getAbyssalRecoveryTombstoneDiagnosticsForTests.bind(null, ports),
  };
}

module.exports = { createAbyssalRecoveryTombstoneOperations };
