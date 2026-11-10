"use strict";

/**
 * DATABASE CONTROLLER:
 * In-memory cached database layer.
 *
 * All tables are loaded into memory at startup. Reads are served
 * instantly from the cache. Writes update the cache immediately and
 * schedule a debounced flush to disk so hot write paths stay cheap while the
 * on-disk JSON files are still written through a safer recovery-friendly path.
 *
 * The public API (read / write / remove) is unchanged — every
 * consumer in the codebase works without modification.
 */

const crypto = require("node:crypto");
const path = require("path");
const fs = require("fs");
const { isDeepStrictEqual } = require("util");
const pc = require("picocolors");

const log = require("../utils/logger");
const sqliteStore = require("./sqliteStore");
const persistenceWorker = require("./persistenceWorker");
const persistenceLeasePolicy = require("./persistenceLeasePolicy");
const persistenceRoles = require("./persistenceRoles");
const storePaths = require("./storeRoot");
const {
  stageFileAtomicSync,
  stageFileCopyAtomicSync,
} = require("../services/_shared/atomicFilePublication");

// ── Config ──────────────────────────────────────────────────────────
// Path resolution lives in ./storeRoot so non-database consumers (the runtime
// image stores, admin tooling) can locate this install's data without loading
// the database layer.
const SOURCE_DATA_DIR = storePaths.SOURCE_DATA_DIR;
const LOCAL_DATABASE_ROOT = storePaths.LOCAL_DATABASE_ROOT;
const TEST_STORE_ATTESTATION_FILE = ".evejs-test-store-attestation.json";
const CANONICAL_TEST_COMMAND = "npm run test:isolated -- server/tests/<file>.test.js";
const TEST_STORE_CLEANUP_IN_PROGRESS_SYMBOL = Symbol.for("evejs.testStore.cleanupInProgress");
const PROCESS_ROLE = persistenceRoles.configuredRole();
const OWNS_PERSISTENCE = PROCESS_ROLE !== persistenceRoles.ROLE.READER;
const PRODUCTION_OWNER_ROLES = new Set([
  persistenceRoles.ROLE.WORLD,
  persistenceRoles.ROLE.WALLET,
  persistenceRoles.ROLE.SCHEDULER,
]);

function realpathExisting(filePath) {
  const resolved = path.resolve(filePath);
  const missingSegments = [];
  let existingCandidate = resolved;

  while (true) {
    try {
      return path.resolve(
        fs.realpathSync.native(existingCandidate),
        ...missingSegments,
      );
    } catch (_) {
      const parent = path.dirname(existingCandidate);
      if (parent === existingCandidate) {
        return resolved;
      }
      missingSegments.unshift(path.basename(existingCandidate));
      existingCandidate = parent;
    }
  }
}

function samePath(left, right) {
  return path.resolve(realpathExisting(left)) === path.resolve(realpathExisting(right));
}

function isSubpath(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  const resolvedLeft = realpathExisting(left);
  const resolvedRight = realpathExisting(right);
  return isSubpath(resolvedLeft, resolvedRight) || isSubpath(resolvedRight, resolvedLeft);
}

function protectedGameStoreRoots(attestation = null) {
  return [
    LOCAL_DATABASE_ROOT,
    path.resolve(SOURCE_DATA_DIR, ".."),
    process.env.EVEJS_TEST_STORE_BASELINE_ROOT,
    attestation && attestation.baselineRoot,
  ].filter(Boolean);
}

function isNodeTestLaunchFlag(arg) {
  const value = String(arg || "");
  return value === "--test" || value === "--test=true";
}

function isCurrentNodeTestRunnerProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT ||
      process.env.NODE_TEST_WORKER_ID ||
      process.execArgv.some(isNodeTestLaunchFlag),
  );
}

function verifyNodeTestStoreAttestation() {
  const dataDir = process.env.EVEJS_GAMESTORE_DATA_DIR;
  const storeRoot = process.env.EVEJS_TEST_STORE_ROOT;
  if (
    process.env.EVEJS_TEST_STORE_ISOLATED !== "1" ||
    !dataDir ||
    !storeRoot
  ) {
    return false;
  }
  const attestationPath = path.resolve(
    process.env.EVEJS_TEST_STORE_ATTESTATION ||
      path.join(storeRoot, TEST_STORE_ATTESTATION_FILE),
  );
  if (!fs.existsSync(attestationPath)) {
    return false;
  }
  if (!isSubpath(realpathExisting(attestationPath), realpathExisting(storeRoot))) {
    return false;
  }
  if (!samePath(dataDir, path.join(storeRoot, "data"))) {
    return false;
  }
  if (!isSubpath(realpathExisting(dataDir), realpathExisting(storeRoot))) {
    return false;
  }
  try {
    const attestation = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
    const attested =
      attestation.schemaVersion === 1 &&
      attestation.kind === "evejs-test-store" &&
      attestation.createdBy === "server/tests/helpers/isolatedGameStore.js" &&
      samePath(attestation.storeRoot, storeRoot) &&
      samePath(attestation.dataDir, dataDir);
    if (!attested) {
      return false;
    }
    const storeRealpath = realpathExisting(storeRoot);
    const dataRealpath = realpathExisting(dataDir);
    return !protectedGameStoreRoots(attestation).some((protectedRoot) =>
      pathsOverlap(storeRealpath, protectedRoot) || isSubpath(dataRealpath, realpathExisting(protectedRoot)));
  } catch (_) {
    // ignored: an attestation that cannot be checked does not mark a test store (fail closed)
    return false;
  }
}

function assertNodeTestIsolationBeforeOpen() {
  if (!isCurrentNodeTestRunnerProcess()) {
    return;
  }
  if (verifyNodeTestStoreAttestation()) {
    return;
  }
  throw new Error(
    "Refusing to import server/src/gameStore in an unisolated node:test process. " +
      `Use the isolated runner before product imports: ${CANONICAL_TEST_COMMAND}`,
  );
}

function resolveDataDir() {
  assertNodeTestIsolationBeforeOpen();
  return storePaths.resolveDataDir();
}

const DATA_DIR = resolveDataDir();
if (
  PROCESS_ROLE === persistenceRoles.ROLE.STANDALONE &&
  !verifyNodeTestStoreAttestation()
) {
  const error = new Error(
    "GameStore standalone ownership is restricted to an attested isolated test store; use maintenance for an explicit offline writer",
  );
  error.code = "GAMESTORE_STANDALONE_REQUIRES_ISOLATION";
  throw error;
}
const FLUSH_DELAY_MS = 2000; // debounce: flush 2s after last write
const RECOVERABLE_EMPTY_TABLES = new Set([
  "crimewatchRuntime",
  "npcRuntimeState",
  "npcControlState",
  "npcEntities",
  "npcModules",
  "npcCargo",
  "npcRuntimeControllers",
  "npcWrecks",
  "npcWreckItems",
  "wormholeRuntimeState",
  "probeRuntimeState",
  "dungeonRuntimeState",
  "missionRuntimeState",
  "researchRuntimeState",
  "planetRuntimeState",
  "planetOrbitalState",
]);
// ────────────────────────────────────────────────────────────────────

// ── SQLite-backed tables (incremental migration off per-table JSON) ──
// Tables listed here persist to a single SQLite database — one SQL table
// each, keyed by top-level entity — instead of a data.json file. Reads and
// writes still flow through the in-memory cache and the same public API;
// only the durable backend differs. To migrate a table: add its name here
// and run migrateJsonToSqlite.js to seed its existing rows.
const SQLITE_TABLES = new Set([
  // First wave: clean flat {id → record} maps.
  "skillPlans",
  "skillQueues",
  "skillTradingState",
  "skills",
  "characters",
  "items",
  "raffles",
  "marketEscrow",
  // Second wave: remaining runtime tables not persistence-tested via data.json.
  "corporationRuntime",
  "alliances",
  "bookmarkFolders",
  "bookmarkGroups",
  "bookmarkKnownFolders",
  "bookmarks",
  "calendarEvents",
  "calendarResponses",
  "characterEnergyState",
  "corporationBills",
  "corporationGoals",
  "industryBlueprintState",
  "industryRuntime",
  "insuranceContracts",
  "killRights",
  "killmails",
  "mail",
  "mapTelemetry",
  "moduleGroupingState",
  "notifications",
  "npcEntities",
  "npcModules",
  "npcRuntimeControllers",
  "planetOrbitalState",
  "planetRuntimeState",
  "playerBounties",
  "rafflesRuntime",
  "savedFittings",
  "shipCosmetics",
  "shipSkinComponentRuntime",
  "shipSkinDraftRuntime",
  "shipSkinSequencingRuntime",
  "shipSkinThirdPartyRuntime",
  "dynamicResourceRuntime",
  "solarSystemInterferenceState",
  "structurePaintwork",
  "structureProfiles",
  "structureTetherRestrictions",
  "structures",
  "wormholeRuntimeState",
  // Third wave: empty / created-on-demand runtime tables (no legacy rows yet).
  "accessGroups",
  "bookmarkRuntimeState",
  "bookmarkSubfolders",
  "characterExpertSystems",
  "characterNotes",
  "corpSkillPlans",
  "contrabandPenalties",
  "customsInspectionCases",
  "crimewatchRuntime",
  "contractSettlements",
  "reprocessingSettlements",
  "missionRewardSettlements",
  "planetaryCustomsSettlements",
  "corporationLiquidations",
  "corporationFoundings",
  "allianceFoundings",
  "allianceDepartures",
  "corporationVotes",
  "achievements",
  "freelanceProjects",
  "dailyGoals",
  "homefrontReplay",
  "incursionReplay",
  "incursionLifecycle",
  "evermarkEntitlements",
  "evermarkPurchases",
  "lpStorePurchases",
  "industryFacilityState",
  "industryInstallSettlements",
  "jumpCloneActivationSettlements",
  "jumpBridgeSettlements",
  "industryJobs",
  "lpWallets",
  "marketRuntime",
  "miningLedger",
  "newEdenStore",
  "newEdenStorePurchaseSettlements",
  "newEdenStoreRuntime",
  "projectDiscoveryState",
  "npcControlState",
  "npcRuntimeState",
  "npcSpawnSites",
  "pendingNpcBounties",
  "probeRuntimeState",
  "reprocessingFacilityState",
  "repairOperations",
  "sharedBookmarkFolders",
  "shipLogoFittings",
  "scheduledJobs",
  "shipSelfDestructs",
  "breacherPodDeaths",
  "campaignTrailProgress",
  "eventLifecycle",
  "fwOpenReplay",
  "structureAssetSafety",
  "structureDeliveryRuntime",
  "tradeRuntime",
  "walletAuthorityState",
  // Fourth wave: tables that appear in persistence-style tests (verified the
  // tests seed via data.json fixtures / assert via the service, not by reading
  // the file back, so auto-seed keeps them green).
  "shipDirt",
  "shipKillCounters",
  // Tables whose tests save/restore the source data.json or read it read-only
  // for report parity — both unaffected because the source file is untouched.
  "moonExtractions",
  "overviewSharedPresets",
  "sharedSettings",
  "sovereignty",
  "dungeonRuntimeState",
  "miningRuntimeState",
  "miningCargoCommits",
  "missionRuntimeState",
  "researchRuntimeState",
  // Final pair: accountLoginPersistenceParity now proves persistence by reading
  // the SQLite row back instead of the legacy data.json file.
  "accounts",
  "identityState",
  // Backfill (2026-06-25): runtime tables missed by the earlier waves. They
  // share the exact persistence path as their already-migrated siblings —
  // npcCargo/npcWrecks/npcWreckItems go through nativeNpcStore like
  // npcEntities/npcModules; corporations through corporationState like
  // corporationRuntime/alliances — and were simply never added. Seed existing
  // rows with: node src/gameStore/migrateJsonToSqlite.js <table...>
  "npcCargo",
  "npcWrecks",
  "npcWreckItems",
  "corporations",
  // Chat runtime state previously lived in _secondary/data/chat JSON/JSONL
  // sidecars. Keep it in the same SQLite runtime backend as the rest of the
  // mutable world state.
  "chatState",
  "chatStaticContracts",
  "chatBacklog",
  "contractRuntime",
  "abyssalFilamentCompensations",
  "abyssalRecoveryTombstones",
  "jumpCloneInstallSettlements",
  // Moon ore fields left by fractured moon chunks, one row per field.
  "moonMiningFields",
]);
const SQLITE_DB_PATH = path.resolve(DATA_DIR, "..", "gamestore.sqlite");
const PERSISTENCE_OWNER_LEASE_MS = persistenceLeasePolicy.configuredLeaseMs(
  process.env.EVEJS_PERSISTENCE_OWNER_LEASE_MS,
);
const PERSISTENCE_OWNER_ACQUIRE_WAIT_MS =
  persistenceLeasePolicy.configuredAcquisitionWaitMs(
    process.env.EVEJS_PERSISTENCE_OWNER_ACQUIRE_WAIT_MS,
    PERSISTENCE_OWNER_LEASE_MS,
  );
const PERSISTENCE_OWNER_RENEW_MS = Math.max(
  1_000,
  Math.floor(PERSISTENCE_OWNER_LEASE_MS / 3),
);
// Only supervised production roles need an identity that survives an ordered
// child restart. Offline maintenance and isolated standalone processes must
// never collapse into one owner merely because a shell exported a static ID.
const PERSISTENCE_OWNER_INSTANCE = String(
  PRODUCTION_OWNER_ROLES.has(PROCESS_ROLE)
    ? process.env.EVEJS_GAMESTORE_OWNER_INSTANCE ||
      `${PROCESS_ROLE}:${process.pid}:${crypto.randomUUID()}`
    : `${PROCESS_ROLE}:${process.pid}:${crypto.randomUUID()}`,
);
let sqliteRecoveryRequired = true;
let persistenceCallbacksReady = false;
let persistenceOwnerFence = null;
let persistenceOwnerRenewTimer = null;
let persistenceOwnerFailure = null;
const persistenceOwnerLostListeners = new Set();

if (OWNS_PERSISTENCE) {
  persistenceWorker.configureOwner({
    role: PROCESS_ROLE,
    instanceId: PERSISTENCE_OWNER_INSTANCE,
  });
}

function stopPersistenceOwnerRenewal() {
  if (persistenceOwnerRenewTimer) {
    clearInterval(persistenceOwnerRenewTimer);
    persistenceOwnerRenewTimer = null;
  }
}

function persistenceOwnerError(error, fallbackCode) {
  const normalized = error instanceof Error
    ? error
    : new Error(String(error || "persistence owner failure"));
  if (!normalized.code && fallbackCode) normalized.code = fallbackCode;
  return normalized;
}

function failPersistenceOwner(error) {
  if (persistenceOwnerFailure) return;
  persistenceOwnerFailure = persistenceOwnerError(
    error,
    "PERSISTENCE_OWNER_LEASE_LOST",
  );
  dbErr(
    `persistence owner lease lost for ${PROCESS_ROLE}: ` +
      `${persistenceOwnerFailure.message}`,
  );

  // A fenced authority must not continue accepting state-changing traffic.
  // The process entry point decides what that means for the process: the
  // production owners shut down and exit 1 (ownerProcessShutdown.js); test
  // and maintenance processes surface the stored error to their next mutation.
  const failure = persistenceOwnerFailure;
  setImmediate(() => {
    for (const listener of persistenceOwnerLostListeners) {
      try {
        listener(failure);
      } catch (listenerError) {
        dbWarn(`persistence owner loss listener failed: ${listenerError.message}`);
      }
    }
  });
}

// Subscribes to the loss of this process's persistence owner lease. A listener
// added after the loss is told at once. Returns an unsubscribe function.
function onPersistenceOwnerLost(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("onPersistenceOwnerLost requires a function");
  }
  persistenceOwnerLostListeners.add(listener);
  if (persistenceOwnerFailure) {
    const failure = persistenceOwnerFailure;
    setImmediate(() => {
      if (persistenceOwnerLostListeners.has(listener)) listener(failure);
    });
  }
  return () => persistenceOwnerLostListeners.delete(listener);
}

function renewPersistenceOwnerLeaseNow() {
  assertPersistenceOwnerHealthy();
  if (!OWNS_PERSISTENCE || !persistenceOwnerFence) {
    throw persistenceOwnerError(
      `persistence owner ${PROCESS_ROLE} has no acquired lease to renew`,
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  try {
    persistenceOwnerFence = persistenceWorker.renewOwner(SQLITE_DB_PATH, {
      leaseMs: PERSISTENCE_OWNER_LEASE_MS,
    });
  } catch (error) {
    if (error && error.code === "PERSISTENCE_OWNER_STALE") {
      failPersistenceOwner(error);
      throw persistenceOwnerFailure;
    }
    throw error;
  }
  if (!persistenceOwnerFence) {
    throw persistenceOwnerError(
      `persistence owner ${PROCESS_ROLE} renewal returned no fence`,
      "PERSISTENCE_OWNER_RENEW_FAILED",
    );
  }
  return { ...persistenceOwnerFence };
}

function renewPersistenceOwnerLease() {
  if (!persistenceOwnerFence || persistenceOwnerFailure) return;
  try {
    renewPersistenceOwnerLeaseNow();
  } catch (error) {
    const leaseExpiresAt = Number(
      persistenceOwnerFence && persistenceOwnerFence.leaseExpiresAt,
    );
    if (
      error &&
      error.code !== "PERSISTENCE_OWNER_STALE" &&
      Number.isFinite(leaseExpiresAt) &&
      Date.now() < leaseExpiresAt
    ) {
      dbWarn(
        `persistence owner lease renewal deferred for ${PROCESS_ROLE}: ` +
          `${error.message}`,
      );
      return;
    }
    failPersistenceOwner(error);
  }
}

function startPersistenceOwnerRenewal() {
  if (persistenceOwnerRenewTimer || !persistenceOwnerFence) return;
  persistenceOwnerRenewTimer = setInterval(
    renewPersistenceOwnerLease,
    PERSISTENCE_OWNER_RENEW_MS,
  );
  if (typeof persistenceOwnerRenewTimer.unref === "function") {
    persistenceOwnerRenewTimer.unref();
  }
}

// Long synchronous startup/shutdown loops prevent the interval above from
// running. Refresh near expiry at explicit table boundaries so a healthy owner
// does not self-fence merely because JavaScript could not service the timer.
function renewPersistenceOwnerLeaseAtBoundary() {
  if (!persistenceOwnerFence) return null;
  assertPersistenceOwnerHealthy();
  persistenceOwnerFence = persistenceWorker.getOwnerFence() || persistenceOwnerFence;
  const leaseExpiresAt = Number(persistenceOwnerFence.leaseExpiresAt);
  if (
    Number.isFinite(leaseExpiresAt) &&
    leaseExpiresAt - Date.now() <= PERSISTENCE_OWNER_RENEW_MS
  ) {
    return renewPersistenceOwnerLeaseNow();
  }
  return { ...persistenceOwnerFence };
}

function persistenceOwnerAcquireOptions() {
  return {
    leaseMs: PERSISTENCE_OWNER_LEASE_MS,
    waitForAvailableMs: PRODUCTION_OWNER_ROLES.has(PROCESS_ROLE)
      ? PERSISTENCE_OWNER_ACQUIRE_WAIT_MS
      : 0,
    // Standalone is available only for attested isolated tests. Those tests
    // deliberately simulate hard process loss and need immediate disposable
    // takeover; production roles always respect the durable lease.
    forceTakeover: PROCESS_ROLE === persistenceRoles.ROLE.STANDALONE,
    adoptLegacyTables: persistenceRoles.tablesOwnedByRole(
      PROCESS_ROLE,
      SQLITE_TABLES,
    ),
  };
}

function acquirePersistenceOwner(options = {}) {
  if (!OWNS_PERSISTENCE) return null;
  if (persistenceOwnerFailure) throw persistenceOwnerFailure;
  if (persistenceOwnerFence) {
    assertPersistenceOwnerHealthy();
    if (options.validateDurable !== true) return persistenceOwnerFence;
  }

  const firstAcquisition = !persistenceOwnerFence;
  persistenceOwnerFence = persistenceWorker.acquireOwner(
    SQLITE_DB_PATH,
    persistenceOwnerAcquireOptions(),
  );
  if (PRODUCTION_OWNER_ROLES.has(PROCESS_ROLE)) {
    persistenceOwnerFence = persistenceWorker.startOwnerLease(
      SQLITE_DB_PATH,
      {
        leaseMs: PERSISTENCE_OWNER_LEASE_MS,
        renewMs: PERSISTENCE_OWNER_RENEW_MS,
      },
    );
  }
  startPersistenceOwnerRenewal();
  if (firstAcquisition) {
    dbLog(
      `acquired persistence owner ${PROCESS_ROLE} epoch=${persistenceOwnerFence.epoch} ` +
        `instance=${PERSISTENCE_OWNER_INSTANCE} leaseMs=${PERSISTENCE_OWNER_LEASE_MS}`,
    );
  }
  return persistenceOwnerFence;
}

function requirePersistenceOwnerFence() {
  assertPersistenceOwnerHealthy();
  const fence = persistenceWorker.getOwnerFence();
  if (!fence) {
    throw persistenceOwnerError(
      `persistence owner ${PROCESS_ROLE} has not been acquired`,
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  return fence;
}

function assertPersistenceOwnerHealthy() {
  if (persistenceOwnerFailure) throw persistenceOwnerFailure;
  const ownerError = persistenceWorker.getOwnerError();
  if (ownerError) {
    failPersistenceOwner(ownerError);
    throw persistenceOwnerFailure;
  }
  const fence = persistenceWorker.getOwnerFence();
  const leaseExpiresAt = Number(fence && fence.leaseExpiresAt);
  if (
    fence &&
    Number.isFinite(leaseExpiresAt) &&
    Date.now() >= leaseExpiresAt
  ) {
    const error = persistenceOwnerError(
      new Error(
        `persistence owner ${PROCESS_ROLE} epoch ${fence.epoch} lease expired`,
      ),
      "PERSISTENCE_OWNER_STALE",
    );
    error.ownerRole = PROCESS_ROLE;
    error.ownerEpoch = fence.epoch;
    error.leaseExpiresAt = leaseExpiresAt;
    failPersistenceOwner(error);
    throw persistenceOwnerFailure;
  }
}

// Once per process, and only from the world owner (or a standalone process),
// so a clustered boot says it once rather than once per owner role.
let freePageUsageChecked = false;
function warnOnceWhenMostlyFreePages() {
  if (
    freePageUsageChecked ||
    (
      PROCESS_ROLE !== persistenceRoles.ROLE.WORLD &&
      PROCESS_ROLE !== persistenceRoles.ROLE.STANDALONE
    )
  ) {
    return;
  }
  freePageUsageChecked = true;
  let warning;
  try {
    warning = sqliteStore.freeSpaceWarning(sqliteStore.readPageUsage());
  } catch (error) {
    dbWarn(`could not read gamestore.sqlite page usage: ${error.message}`);
    return;
  }
  if (warning) {
    dbWarn(warning);
  }
}

function openSqliteForProcessRole() {
  const readOnly = !OWNS_PERSISTENCE;
  if (
    SQLITE_TABLES.size > 0 &&
    (
      sqliteStore.getDatabasePath() !== SQLITE_DB_PATH ||
      sqliteStore.isReadOnly() !== readOnly
    )
  ) {
    sqliteStore.init(SQLITE_DB_PATH, { readOnly });
    sqliteRecoveryRequired = !readOnly;
    if (!readOnly) {
      warnOnceWhenMostlyFreePages();
    }
  }
  if (!OWNS_PERSISTENCE) {
    // Passive readers may load durable rows, but never acquire a journal lease
    // and never recover or acknowledge another process's outbox.
    sqliteRecoveryRequired = false;
    return null;
  }
  return sqliteStore.getDatabasePath();
}

function recoverPersistenceOwnerOperations() {
  if (SQLITE_TABLES.size > 0 && sqliteRecoveryRequired) {
    if (!persistenceCallbacksReady) {
      throw new Error(
        "persistence recovery requested before callbacks were installed",
      );
    }
    // Clear the recursion guard before the callback rebuilds a baseline from
    // this same connection. All recovery now routes through the controller: it
    // applies only this role's rows, invokes the exact callback, and only then
    // acknowledges/deletes them.
    sqliteRecoveryRequired = false;
    let recovered;
    try {
      recovered = persistenceWorker.recover(SQLITE_DB_PATH);
    } catch (error) {
      // Applied rows remain journaled until callback acceptance, so the next
      // readiness check can retry the exact batch without process-local state.
      sqliteRecoveryRequired = true;
      throw error;
    }
    if (recovered.length > 0) {
      dbWarn(
        `recovered ${recovered.length} unacknowledged persistence operation` +
          (recovered.length === 1 ? "" : "s") +
          " before loading SQLite baselines",
      );
    }
  }
}

/**
 * Explicitly acquire this process's durable persistence lease without loading
 * or seeding any application table. Offline maintenance tools call this before
 * taking a backup so exclusivity is proven before their first mutable action.
 * Recovery remains opt-in because the durable outbox itself belongs in that
 * pre-mutation backup.
 */
function acquirePersistenceOwnerLease(options = {}) {
  if (!OWNS_PERSISTENCE) {
    throw persistenceOwnerError(
      `gameStore reader ${PROCESS_ROLE} cannot acquire a persistence owner lease`,
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  openSqliteForProcessRole();
  const fence = acquirePersistenceOwner({ validateDurable: true });
  if (options && options.recover === true) {
    recoverPersistenceOwnerOperations();
  }
  return { ...fence };
}

function ensureSqliteReady() {
  openSqliteForProcessRole();
  if (!OWNS_PERSISTENCE) return;
  acquirePersistenceOwner();
  recoverPersistenceOwnerOperations();
}

function isSqliteTable(table) {
  return SQLITE_TABLES.has(table);
}
// ────────────────────────────────────────────────────────────────────

// ── Cache state ─────────────────────────────────────────────────────
const cache = {};            // table name → parsed JS object
const dirty = new Set();     // tables that need flushing
const flushTimers = {};      // table name → pending setTimeout id
const tableFlushHolds = new Map();
const transientPaths = {};   // table name → Set of cache paths excluded from disk flush
const flushBaselines = {};   // sqlite table → Map(key → last-persisted JSON string)
const inFlightFlushes = new Map(); // sqlite table → exact unacknowledged operation
const lastCompletedPersistenceOperationId = new Map(); // table → durable monotonic ID
let preloaded = false;

// ── Dirty-row tracking (flush fast path) ────────────────────────────
// Default ON (opt out with EVEJS_GAMESTORE_DIRTY_ROWS=0, which restores the
// whole-table re-serialize path). Path-scoped writes record exactly which
// stored row they touched, so flushSqliteTable re-serializes only those rows —
// turning a whole-table re-stringify (e.g. wormhole ~15ms) into O(changed rows)
// (measured ~280x: 19.55ms -> 0.07ms on a 3063-pair wormhole flush). Anything
// that can't be cleanly localized (root writes, whole-group writes, transient
// markers spanning several rows) falls back to the exact full diff, so the fast
// path is never less correct. Caveat: an in-place cache mutation NOT followed by a
// localizing write to that same row would be missed (the full path catches it
// by re-serializing everything); Phase 0.5 swept in-place mutations, which is
// why this stayed opt-in through validation before defaulting on.
const DIRTY_ROWS_TRACKING = process.env.EVEJS_GAMESTORE_DIRTY_ROWS !== "0";
const dirtyRowKeys = {};     // sqlite table → Set(rowKey) touched since last flush
const fullDirty = new Set(); // sqlite tables that must use the full diff next flush
const flushStats = { partial: 0, full: 0 }; // observability for tests/diagnostics
// ────────────────────────────────────────────────────────────────────

// ── Helpers ─────────────────────────────────────────────────────────

function dbTag() {
  return pc.bgGreen(pc.black(" DB  "));
}

function timestamp() {
  return pc.dim(new Date().toISOString().slice(11, 19));
}

// gameStore diagnostics go to BOTH lanes.
//
// The console keeps its coloured " DB  " tag — that is what the operator reads
// live. The same record is additionally appended to the server log (logs/server.log in the data root) in
// plain text, because until 2026-08-08 the entire persistence layer (including
// write failures and data-loss warnings) existed on the console ONLY: nothing
// dbLog/dbWarn/dbErr ever emitted was reachable by log tailing, by ErrorWatch,
// or by a post-mortem grep of server/logs.
//
// No lazy require is needed: `log` is already imported at the top of this
// module and the logger depends only on config + rotatingLog (fs/path), never
// on gameStore, so there is no cycle in either direction.
//
// The `[GameStore]` prefix is the bracketed tag ErrorWatch's signature
// normaliser keys on (tools/ErrorWatch/watch.js signatureOf), and the levels
// match its WATCHED_LEVELS: dbErr => ERR, dbWarn => WRN, dbLog => LOG.
const ANSI_STYLE_CODES = new RegExp("\\u001B\\[[0-9;]*m", "g");

function plainDbRecord(message) {
  const text =
    message instanceof Error
      ? message.stack || message.message
      : String(message);
  // Callers colour some messages inline (pc.cyan(table), pc.green("flushed")).
  // Colour belongs on the console lane only; the file lane gets plain text.
  return `[GameStore] role=${PROCESS_ROLE} pid=${process.pid} ` +
    text.replace(ANSI_STYLE_CODES, "");
}

function dbLog(message) {
  log.flushStack();
  log.print(`${timestamp()} ${dbTag()} ${message}`);
  log.writeServerLog("LOG", plainDbRecord(message));
}

function dbWarn(message) {
  log.flushStack();
  log.print(`${timestamp()} ${dbTag()} ${pc.yellow(message)}`);
  log.writeServerLog("WRN", plainDbRecord(message));
}

function dbErr(message) {
  log.flushStack();
  log.printError(`${timestamp()} ${dbTag()} ${pc.red(message)}`);
  log.writeServerLog("ERR", plainDbRecord(message));
}

function dataFilePath(table) {
  return path.join(DATA_DIR, table, "data.json");
}

function backupFilePath(table) {
  return `${dataFilePath(table)}.bak`;
}

function isSameValue(left, right) {
  if (left === right) {
    return true;
  }
  return isDeepStrictEqual(left, right);
}

function getSegments(pathKey) {
  return String(pathKey || "/").split("/").filter(Boolean);
}

function normalizeTransientPath(pathKey) {
  const segments = getSegments(pathKey);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function getTransientPathSet(table) {
  if (!transientPaths[table]) {
    transientPaths[table] = new Set();
  }
  return transientPaths[table];
}

function clearTransientPathsForPrefixes(table, pathKeys) {
  const normalizedPaths = new Set(
    (Array.isArray(pathKeys) ? pathKeys : [pathKeys])
      .map(normalizeTransientPath),
  );
  const pathSet = transientPaths[table];
  if (!pathSet || pathSet.size === 0 || normalizedPaths.size === 0) {
    return [];
  }

  if (normalizedPaths.has("/")) {
    const clearedPaths = [...pathSet];
    pathSet.clear();
    return clearedPaths;
  }

  const clearedPaths = [];
  for (const candidatePath of [...pathSet]) {
    // A transient marker is cleared when any of its path ancestors is in the
    // removal set. Walking the candidate's usually-one-or-two ancestors keeps
    // a 5,000-row bulk cleanup O(markers * path depth), instead of rescanning
    // and copying the whole marker set once per removed row.
    let candidateAncestor = candidatePath;
    while (candidateAncestor && candidateAncestor !== "/") {
      if (normalizedPaths.has(candidateAncestor)) {
        pathSet.delete(candidatePath);
        clearedPaths.push(candidatePath);
        break;
      }
      const separatorIndex = candidateAncestor.lastIndexOf("/");
      candidateAncestor = separatorIndex > 0
        ? candidateAncestor.slice(0, separatorIndex)
        : "/";
    }
  }
  return clearedPaths;
}

function setTransientPath(table, pathKey, enabled = true) {
  setTransientPaths(table, [pathKey], enabled);
}

function isTransientPath(table, pathKey) {
  const normalizedPath = normalizeTransientPath(pathKey);
  const pathSet = transientPaths[table];
  if (!pathSet || pathSet.size === 0) {
    return false;
  }
  for (const transientPath of pathSet) {
    if (
      transientPath === "/" ||
      normalizedPath === transientPath ||
      normalizedPath.startsWith(`${transientPath}/`)
    ) {
      return true;
    }
  }
  return false;
}

function setTransientPaths(table, pathKeys, enabled = true) {
  const passiveReaderMarker =
    PROCESS_ROLE === persistenceRoles.ROLE.READER && enabled === true;
  if (!passiveReaderMarker) {
    persistenceRoles.assertRoleMayMutateTable(
      PROCESS_ROLE,
      table,
      enabled ? "mark transient paths for" : "clear transient paths for",
    );
    assertPersistenceOwnerHealthy();
  }
  const normalizedPaths = [...new Set(
    (Array.isArray(pathKeys) ? pathKeys : [pathKeys])
      .map(normalizeTransientPath),
  )];
  const pathSet = getTransientPathSet(table);
  if (enabled) {
    for (const normalizedPath of normalizedPaths) {
      pathSet.add(normalizedPath);
      // A row that was already on disk must leave it. The full diff found it
      // by rescanning the table; the partial flush only sees dirty rows.
      if (!passiveReaderMarker) {
        markRowDirty(table, getSegments(normalizedPath));
      }
    }
  } else {
    // A cleared marker puts a row back into the flush snapshot that its last
    // write deliberately kept out, so nothing has it in the dirty set. Mark it
    // here, or a row that stays live after its marker clears -- loot a player
    // took out of a runtime-only container -- never reaches disk once the
    // table is back on the partial-flush path.
    const clearedPaths = clearTransientPathsForPrefixes(table, normalizedPaths);
    for (const clearedPath of clearedPaths) {
      markRowDirty(table, getSegments(clearedPath));
    }
    if (clearedPaths.length > 0) {
      scheduleFlush(table);
    }
  }
}

function cloneForFlush(value) {
  return JSON.parse(JSON.stringify(value));
}

function deletePath(target, pathKey) {
  const segments = getSegments(pathKey);
  if (segments.length === 0) {
    return {};
  }

  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (
      current === null ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      return target;
    }
    current = current[segment];
  }

  const finalKey = segments[segments.length - 1];
  if (current && typeof current === "object" && finalKey in current) {
    delete current[finalKey];
  }
  return target;
}

function buildFlushSnapshot(table) {
  const source = cache[table];
  const pathSet = transientPaths[table];
  if (!pathSet || pathSet.size === 0) {
    return source;
  }

  const snapshot = cloneForFlush(source);
  for (const transientPath of pathSet) {
    deletePath(snapshot, transientPath);
  }
  return snapshot;
}

// Map each transient marker onto the one stored row it sits in, so the partial
// flush can leave those rows out without cloning the whole table the way
// buildFlushSnapshot does. Returns null when a marker spans several rows (the
// table root, or a whole row group), which only the full diff handles.
function indexTransientRows(table) {
  const index = new Map(); // rowKey -> { whole, subPaths }
  const pathSet = transientPaths[table];
  if (!pathSet || pathSet.size === 0) {
    return index;
  }
  const groups = sqliteStore.rowGroupsFor(table);
  for (const transientPath of pathSet) {
    const segments = getSegments(transientPath);
    if (segments.length === 0) {
      return null;
    }
    let rowKey = segments[0];
    let rowDepth = 1;
    if (groups && groups.includes(segments[0])) {
      if (segments.length === 1) {
        return null;
      }
      rowKey = `${segments[0]}${sqliteStore.ROW_KEY_SEP}${segments[1]}`;
      rowDepth = 2;
    }
    let entry = index.get(rowKey);
    if (!entry) {
      entry = { whole: false, subPaths: [] };
      index.set(rowKey, entry);
    }
    if (segments.length === rowDepth) {
      entry.whole = true;
    } else {
      entry.subPaths.push(`/${segments.slice(rowDepth).join("/")}`);
    }
  }
  return index;
}

// The stored value of one row as buildFlushSnapshot would have produced it.
function flushRowValue(table, rowKey, transientRows) {
  const value = sqliteStore.rowValueForKey(table, cache[table] || {}, rowKey);
  const entry = transientRows.get(rowKey);
  if (!entry || value === undefined) {
    return value;
  }
  if (entry.whole) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const rowSnapshot = cloneForFlush(value);
  for (const subPath of entry.subPaths) {
    deletePath(rowSnapshot, subPath);
  }
  return rowSnapshot;
}

function ensureDataFile(filePath) {
  if (!fs.existsSync(filePath)) {
    safeWriteFileSync(filePath, JSON.stringify({}, null, 2));
  }
}

function safeWriteFileSync(filePath, contents) {
  let backupStage = null;
  let dataStage = null;
  try {
    // Acquire before preparing any owner publication, then revalidate the
    // exact durable fence after the comparatively expensive write + fsync.
    ensureSqliteReady();
    const ownerFence = requirePersistenceOwnerFence();
    if (fs.existsSync(filePath)) {
      try {
        backupStage = stageFileCopyAtomicSync(filePath, `${filePath}.bak`);
      } catch (error) {
        dbWarn(`backup copy failed for ${path.basename(filePath)}: ${error.message}`);
      }
    }
    dataStage = stageFileAtomicSync(filePath, contents);
    sqliteStore.withPersistenceOwnerPublicationSync(ownerFence, () => {
      if (backupStage) backupStage.publish();
      dataStage.publish();
    });
  } catch (error) {
    if (error && error.code === "PERSISTENCE_OWNER_STALE") {
      failPersistenceOwner(error);
      throw persistenceOwnerFailure;
    }
    throw error;
  } finally {
    try {
      if (backupStage) backupStage.discard();
    } catch (_) {
      // ignored: removing a staged backup file is cleanup; the write's outcome is already decided
    }
    try {
      if (dataStage) dataStage.discard();
    } catch (_) {
      // ignored: removing a staged data file is cleanup; the write's outcome is already decided
    }
  }
}

function readParsedJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (String(raw || "").trim().length === 0) {
      return {
        success: false,
        raw,
        error: new SyntaxError("Unexpected end of JSON input"),
      };
    }
    return {
      success: true,
      raw,
      data: JSON.parse(raw),
    };
  } catch (error) {
    return {
      success: false,
      raw: null,
      error,
    };
  }
}

function getRecoveryCandidates(table) {
  const filePath = dataFilePath(table);
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const candidates = [];
  const backupPath = backupFilePath(table);
  if (fs.existsSync(backupPath)) {
    candidates.push(backupPath);
  }
  if (fs.existsSync(directory)) {
    const tempCandidates = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${baseName}.tmp-`))
      .map((name) => path.join(directory, name))
      .sort((left, right) => {
        try {
          return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
        } catch (error) {
          // ignored: a temp file that vanished during the sort keeps its place (0)
          return 0;
        }
      });
    candidates.push(...tempCandidates);
  }
  return candidates;
}

function tryRecoverTableFile(table) {
  const filePath = dataFilePath(table);
  for (const candidatePath of getRecoveryCandidates(table)) {
    const parsedCandidate = readParsedJsonFile(candidatePath);
    if (!parsedCandidate.success) {
      continue;
    }
    cache[table] = parsedCandidate.data;
    safeWriteFileSync(filePath, parsedCandidate.raw);
    dbWarn(`recovered ${table} from ${path.basename(candidatePath)}`);
    return Buffer.byteLength(parsedCandidate.raw, "utf8");
  }
  return null;
}

function passiveJsonReadError(table, kind, cause = null) {
  const filePath = dataFilePath(table);
  const missing = kind === "missing";
  const error = new Error(
    `gameStore role ${PROCESS_ROLE} cannot load ${table}: ${filePath} ` +
      `${missing ? "does not exist" : "is not valid JSON"}; passive readers do not repair or publish store files`,
    cause ? { cause } : undefined,
  );
  error.code = missing
    ? "GAMESTORE_READER_JSON_MISSING"
    : "GAMESTORE_READER_JSON_INVALID";
  error.processRole = PROCESS_ROLE;
  error.table = table;
  error.filePath = filePath;
  return error;
}

function roleMayPublishTable(table) {
  return persistenceRoles.roleMayMutateTable(PROCESS_ROLE, table);
}

// Whether this process's role is allowed to create or write `table`.
//
// Read paths that bootstrap durable state on demand -- seeding a table, writing
// back a normalised payload -- ask this first so a passive process can skip the
// part it may not persist and still hand back the derived value, instead of
// throwing GAMESTORE_PROCESS_OWNERSHIP_VIOLATION out of a getter.
function mayMutateTable(table) {
  return roleMayPublishTable(table);
}

// ── Cache loading ───────────────────────────────────────────────────

// If a legacy data.json with content exists for a not-yet-migrated table, hand
// it back so loadSqliteTable can seed SQLite from it once.
function readLegacyJsonSeed(table) {
  const filePath = dataFilePath(table);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = readParsedJsonFile(filePath);
  if (parsed.success && parsed.data && typeof parsed.data === "object") {
    return parsed.data;
  }
  return null;
}

function loadSqliteTable(table) {
  ensureSqliteReady();
  const maySeed = OWNS_PERSISTENCE &&
    persistenceRoles.roleMayMutateTable(PROCESS_ROLE, table);
  // Only the table's durable owner may perform first-load JSON seeding. Reader
  // and sibling-owner processes SELECT an existing baseline without creating a
  // table or touching _migrations.
  if (maySeed && !sqliteStore.isMigrated(table)) {
    const ownerFence = requirePersistenceOwnerFence();
    const seed = readLegacyJsonSeed(table);
    if (seed && Object.keys(seed).length > 0) {
      sqliteStore.replaceAll(table, seed, ownerFence);
    }
    sqliteStore.markMigrated(table, ownerFence);
  }
  if (maySeed && table === "dungeonRuntimeState") {
    // Existing migrated installations also need the selective career index.
    // Pay its one-time backfill during owner preload, before gameplay traffic.
    sqliteStore.ensureDungeonReadIndexes(requirePersistenceOwnerFence());
  }
  if (maySeed && ["killmails", "industryJobs", "items"].includes(table)) {
    sqliteStore.ensureCareerReadIndex(table, requirePersistenceOwnerFence());
  }
  if (maySeed) sqliteStore.ensureCareerRowStorage(table, requirePersistenceOwnerFence());
  // Build the cache (assembled) and the flush baseline (one entry per stored
  // row) from the raw rows, so the baseline keys line up with what
  // flushSqliteTable diffs — including per-entity rows for wrapper tables.
  const rawRows = sqliteStore.loadExistingRows(table);
  const parsedRows = {};
  const baseline = new Map();
  const rowGroups = sqliteStore.rowGroupsFor(table);
  let bytes = 0;
  for (const { key, json } of rawRows) {
    const value = JSON.parse(json);
    parsedRows[key] = value;
    // A supported legacy group blob still contains durable siblings that are
    // not separate rows. Convert the whole group once before a partial flush
    // can replace its blob with the empty skeleton and lose those siblings.
    if (
      rowGroups && rowGroups.includes(key) &&
      value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      fullDirty.add(table);
    }
    const serialized = JSON.stringify(value); // re-stringify for a stable diff
    baseline.set(key, serialized);
    bytes += serialized.length;
  }
  cache[table] = sqliteStore.assembleFromRows(table, parsedRows);
  flushBaselines[table] = baseline;
  return bytes;
}

function loadTable(table) {
  if (isSqliteTable(table)) {
    return loadSqliteTable(table);
  }
  const filePath = dataFilePath(table);
  if (!roleMayPublishTable(table)) {
    if (!fs.existsSync(filePath)) {
      throw passiveJsonReadError(table, "missing");
    }
    const parsed = readParsedJsonFile(filePath);
    if (!parsed.success) {
      throw passiveJsonReadError(table, "invalid", parsed.error);
    }
    cache[table] = parsed.data;
    return Buffer.byteLength(parsed.raw, "utf8");
  }
  // An owner must prove its durable lease before observing, caching, creating,
  // or repairing JSON state. This prevents a contender from constructing a
  // stale mutable cache while another process owns the role.
  ensureSqliteReady();
  ensureDataFile(filePath);
  const parsedMain = readParsedJsonFile(filePath);
  if (parsedMain.success) {
    cache[table] = parsedMain.data;
    return Buffer.byteLength(parsedMain.raw, "utf8");
  }

  if (
    RECOVERABLE_EMPTY_TABLES.has(table) &&
    String(parsedMain.raw || "").trim().length === 0
  ) {
    cache[table] = {};
    safeWriteFileSync(filePath, JSON.stringify({}, null, 2));
    dbWarn(`recovered empty ${table} table with default {}`);
    return 2;
  }

  const recoveredBytes = tryRecoverTableFile(table);
  if (recoveredBytes !== null) {
    return recoveredBytes;
  }

  throw parsedMain.error;
}

/**
 * Preload every table directory under data/ into memory.
 * Called once at startup before the TCP server accepts connections.
 */
function preloadAll() {
  if (preloaded) return;

  const totalStart = Date.now();
  // First run / fresh container: the data directory may not exist yet.
  if (!fs.existsSync(DATA_DIR)) {
    if (PROCESS_ROLE === persistenceRoles.ROLE.READER) {
      const error = new Error(
        `gameStore reader data directory does not exist: ${DATA_DIR}`,
      );
      error.code = "GAMESTORE_READER_DATA_DIR_MISSING";
      error.filePath = DATA_DIR;
      throw error;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  const tableDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (PROCESS_ROLE === persistenceRoles.ROLE.READER) {
    const missingJson = tableDirectories.find((table) =>
      !isSqliteTable(table) && !fs.existsSync(dataFilePath(table)));
    if (missingJson) {
      throw passiveJsonReadError(missingJson, "missing");
    }
  }
  const tables = tableDirectories.filter((table) =>
    fs.existsSync(dataFilePath(table)) &&
    (
      !isSqliteTable(table) ||
      persistenceRoles.roleMayMutateTable(PROCESS_ROLE, table)
    ));

  // SQLite-backed tables may not have a data.json directory. Automatically
  // preload only this process's owned tables; foreign durable state remains
  // available through an explicit strict readPersisted call.
  for (const sqliteTable of SQLITE_TABLES) {
    if (
      persistenceRoles.roleMayMutateTable(PROCESS_ROLE, sqliteTable) &&
      !tables.includes(sqliteTable)
    ) {
      tables.push(sqliteTable);
    }
  }

  dbLog(`preloading ${tables.length} tables into memory...`);

  let totalBytes = 0;
  const timings = [];

  for (const table of tables) {
    renewPersistenceOwnerLeaseAtBoundary();
    const t0 = Date.now();
    const bytes = loadTable(table);
    renewPersistenceOwnerLeaseAtBoundary();
    const elapsed = Date.now() - t0;
    totalBytes += bytes;
    timings.push({ table, bytes, elapsed });
  }

  const totalElapsed = Date.now() - totalStart;

  // Log per-table, sorted slowest first
  timings.sort((a, b) => b.elapsed - a.elapsed);
  for (const { table, bytes, elapsed } of timings) {
    const sizeMB = (bytes / 1024 / 1024).toFixed(1);
    const name = table.padEnd(25);
    const time = String(elapsed).padStart(5) + "ms";
    const size = `(${sizeMB} MB)`.padStart(11);
    dbLog(`  ${pc.cyan(name)} ${pc.white(time)}  ${pc.dim(size)}`);
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  dbLog(
    `${pc.green("cache ready")} — ${tables.length} tables, ` +
    `${totalMB} MB loaded in ${pc.bold(totalElapsed + "ms")}`,
  );
  preloaded = true;
}

// ── Debounced async flush ───────────────────────────────────────────

function advanceFlushBaseline(table, upserts = [], deletes = []) {
  let baseline = flushBaselines[table];
  if (!baseline) {
    baseline = new Map();
    flushBaselines[table] = baseline;
  }
  for (const [rowKey, serialized] of upserts) {
    baseline.set(rowKey, serialized);
  }
  for (const rowKey of deletes) {
    baseline.delete(rowKey);
  }
}

function rebuildFlushBaselineFromDisk(table) {
  ensureSqliteReady();
  const baseline = new Map();
  for (const { key, json } of sqliteStore.loadRows(table)) {
    baseline.set(key, JSON.stringify(JSON.parse(json)));
  }
  flushBaselines[table] = baseline;
}

function handlePersistenceWorkerAcknowledged(operation) {
  if (!operation || !operation.table || operation.operationId === undefined) {
    throw new Error("persistence worker returned an invalid durable acknowledgment");
  }
  const inFlight = inFlightFlushes.get(operation.table);
  if (!inFlight) {
    if (
      operation.operationId <=
      (lastCompletedPersistenceOperationId.get(operation.table) || 0)
    ) {
      return;
    }
    throw new Error(
      `unexpected persistence acknowledgment ${operation.operationId} for ${operation.table}`,
    );
  }
  if (inFlight.operationId !== operation.operationId) {
    throw new Error(
      `stale persistence acknowledgment ${operation.operationId} cannot resolve ` +
        `${inFlight.operationId} for ${operation.table}`,
    );
  }

  advanceFlushBaseline(operation.table, inFlight.upserts, inFlight.deletes);
  inFlightFlushes.delete(operation.table);
  lastCompletedPersistenceOperationId.set(operation.table, operation.operationId);

  // Mutations made after this batch was captured kept their dirty-row keys.
  // Once the acknowledged baseline is current, let their normal debounce run.
  if (
    dirty.has(operation.table) &&
    !flushTimers[operation.table] &&
    process[TEST_STORE_CLEANUP_IN_PROGRESS_SYMBOL] !== true
  ) {
    scheduleFlush(operation.table);
  }
}

function handlePersistenceWorkerRecovered(operations = []) {
  if (!Array.isArray(operations)) {
    throw new Error("persistence recovery callback must provide an operation array");
  }
  const recoveredTables = [];
  for (const operation of operations) {
    if (!operation || !operation.table || operation.operationId === undefined) {
      throw new Error("persistence recovery callback contained an invalid operation");
    }
    const inFlight = inFlightFlushes.get(operation.table);
    if (inFlight) {
      if (inFlight.operationId !== operation.operationId) {
        throw new Error(
          `stale recovery ${operation.operationId} cannot resolve ` +
            `${inFlight.operationId} for ${operation.table}`,
        );
      }
      advanceFlushBaseline(operation.table, inFlight.upserts, inFlight.deletes);
      inFlightFlushes.delete(operation.table);
    } else if (
      operation.operationId >
      (lastCompletedPersistenceOperationId.get(operation.table) || 0)
    ) {
      // Controller recovery can happen after cache construction without a
      // surviving in-memory in-flight record. Rebuild successfully before the
      // operation is considered reconciled.
      rebuildFlushBaselineFromDisk(operation.table);
    }
    lastCompletedPersistenceOperationId.set(
      operation.table,
      Math.max(
        operation.operationId,
        lastCompletedPersistenceOperationId.get(operation.table) || 0,
      ),
    );
    recoveredTables.push(operation.table);
  }
  for (const table of new Set(recoveredTables)) {
    if (
      dirty.has(table) &&
      !flushTimers[table] &&
      process[TEST_STORE_CLEANUP_IN_PROGRESS_SYMBOL] !== true
    ) {
      scheduleFlush(table);
    }
  }
}

// Persist a SQLite-backed table by diffing its current cache state against
// the last-persisted baseline and upserting/deleting only the rows that
// actually changed — no whole-table rewrite.
function flushSqliteTable(table, options = {}) {
  persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "flush");
  assertPersistenceOwnerHealthy();
  ensureSqliteReady();
  if (
    persistenceWorker.isEnabled() &&
    !persistenceWorker.isActive() &&
    inFlightFlushes.size > 0
  ) {
    // A replacement controller/worker must reconcile the prior durable journal
    // before a new batch is created. This is triggered by the next real flush,
    // not by a broad autonomous retry scheduler (PST-002 remains separate).
    persistenceWorker.recover(SQLITE_DB_PATH);
  }
  if (inFlightFlushes.has(table)) {
    // Per-table single-flight is part of the persistence protocol. A second
    // diff against the still-unacknowledged baseline could omit a tombstone
    // (for example, insert then delete before the first acknowledgment).
    dirty.add(table);
    return 0;
  }
  let baseline = flushBaselines[table];
  if (!baseline) {
    baseline = new Map();
    flushBaselines[table] = baseline;
  }

  const trackedKeys = dirtyRowKeys[table];
  // Fast path: only when dirty-row tracking is on, the touched rows were all
  // cleanly localized (no fullDirty marker), AND every transient marker sits
  // inside a single row. Setting or clearing a marker marks its row dirty, so
  // the tracked set still covers every row the transient filter changes.
  const transientRows =
    DIRTY_ROWS_TRACKING && trackedKeys && !fullDirty.has(table)
      ? indexTransientRows(table)
      : null;
  const usePartial = transientRows !== null;

  const upserts = [];
  const deletes = [];

  if (usePartial) {
    // Re-serialize ONLY the rows write()/remove() recorded as touched. Each
    // tracked key resolves directly to its stored value (or undefined => the row
    // was removed or is transient) via flushRowValue, which mirrors
    // explodeToRows over buildFlushSnapshot exactly.
    for (const rowKey of trackedKeys) {
      const value = flushRowValue(table, rowKey, transientRows);
      if (value === undefined) {
        if (baseline.has(rowKey)) {
          deletes.push(rowKey);
        }
        continue;
      }
      const serialized = JSON.stringify(value);
      if (baseline.get(rowKey) !== serialized) {
        upserts.push([rowKey, serialized]);
      }
    }
    flushStats.partial += 1;
  } else {
    // Full diff (default / fallback): flatten the whole table to its stored rows
    // and diff every one against the baseline. We re-serialize every row because
    // a root write("/") can't tell write() which entity changed — the diff finds
    // it. The disk write (the expensive part) is already minimal; this is CPU
    // only, on a 2s debounce.
    const snapshot = buildFlushSnapshot(table) || {};
    const rows = sqliteStore.explodeToRows(table, snapshot);
    const present = new Set();
    for (const rowKey of Object.keys(rows)) {
      present.add(rowKey);
      const serialized = JSON.stringify(rows[rowKey]);
      if (baseline.get(rowKey) !== serialized) {
        upserts.push([rowKey, serialized]);
      }
    }
    for (const rowKey of baseline.keys()) {
      if (!present.has(rowKey)) {
        deletes.push(rowKey);
      }
    }
    flushStats.full += 1;
  }

  if (upserts.length === 0 && deletes.length === 0) {
    fullDirty.delete(table);
    delete dirtyRowKeys[table];
    return 0;
  }

  // The journal INSERT is synchronous by design: the exact batch and its
  // AUTOINCREMENT identity must be durable before dirty tracking is released or
  // any asynchronous worker can observe the operation.
  const operation = sqliteStore.enqueuePersistenceOperation(
    table,
    upserts,
    deletes,
    requirePersistenceOwnerFence(),
  );
  const useWorker = persistenceWorker.isEnabled() && options.sync !== true;
  inFlightFlushes.set(table, { ...operation, submittedToWorker: useWorker });
  fullDirty.delete(table);
  delete dirtyRowKeys[table];

  // A synchronous caller may block, so it reconciles the journal directly on
  // the main connection. Async writes retain the outbox row until the matching
  // worker acknowledgment is durably consumed.
  if (useWorker) {
    try {
      persistenceWorker.submitWrite(SQLITE_DB_PATH, table, upserts, deletes, {
        operationId: operation.operationId,
      });
    } catch (error) {
      // The exact journal row and in-flight record deliberately remain intact.
      // Startup or an explicit synchronous reconciliation can replay it without
      // substituting an approximate full-state diff.
      throw error;
    }
  } else {
    try {
      const reconciled = sqliteStore.reconcilePersistenceOperation(
        operation.operationId,
        table,
        requirePersistenceOwnerFence(),
      );
      if (!reconciled) {
        throw new Error(
          `persistence operation ${operation.operationId} disappeared before reconciliation`,
        );
      }
    } catch (error) {
      // The journal remains authoritative if the transaction rolled back.
      throw error;
    }
    advanceFlushBaseline(table, operation.upserts, operation.deletes);
    inFlightFlushes.delete(table);
  }
  return upserts.length + deletes.length;
}

// A failed or uncertain worker operation stays single-flight and journaled.
// Never replace it with a full-state diff: only its exact tombstones/upserts are
// safe to reconcile, either synchronously or during startup recovery.
function handlePersistenceWorkerError(table, error, failure) {
  dbErr(`persistence worker write failed${table ? ` for ${table}` : ""}: ${error}`);
  if (failure && table) {
    const inFlight = inFlightFlushes.get(table);
    if (inFlight && inFlight.operationId !== failure.operationId) {
      dbWarn(
        `ignored failure ${failure.operationId} while ${inFlight.operationId} is in flight for ${table}`,
      );
    }
  }
}
persistenceWorker.onAcknowledged(handlePersistenceWorkerAcknowledged);
persistenceWorker.onRecovered(handlePersistenceWorkerRecovered);
persistenceWorker.onError(handlePersistenceWorkerError);
persistenceWorker.onOwnerError(failPersistenceOwner);
persistenceCallbacksReady = true;

// Record which stored row a successful write/remove touched, for the flush fast
// path. Conservative: anything that can't be mapped to a single localizable row
// (root writes, whole-group writes, an empty path) marks the table fullDirty so
// the next flush uses the exact full diff. No-op when tracking is disabled or
// the table is not SQLite-backed.
function markRowDirty(table, segments) {
  if (!DIRTY_ROWS_TRACKING || !isSqliteTable(table)) {
    return;
  }
  if (fullDirty.has(table)) {
    return;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    fullDirty.add(table); // root write/overwrite — whole table may have changed
    return;
  }
  const groups = sqliteStore.rowGroupsFor(table);
  const first = segments[0];
  if (groups && groups.includes(first)) {
    if (segments.length === 1) {
      fullDirty.add(table); // wrote/removed the whole group blob
      return;
    }
    let set = dirtyRowKeys[table];
    if (!set) {
      set = new Set();
      dirtyRowKeys[table] = set;
    }
    set.add(`${first}${sqliteStore.ROW_KEY_SEP}${segments[1]}`); // the entity row
    set.add(first); // the group skeleton row, to match explodeToRows' output
    return;
  }
  let set = dirtyRowKeys[table];
  if (!set) {
    set = new Set();
    dirtyRowKeys[table] = set;
  }
  set.add(first); // flat / scalar top-level row
}

// A root write normally cannot prove which rows changed, so it correctly falls
// back to a full diff. Owner modules that already have a complete mutation
// change-set may provide exact paths and retain root-write cache semantics while
// still localizing the durable rows. An empty/invalid hint is never trusted.
function getKnownRootWriteSegments(knownChangedPaths) {
  if (!Array.isArray(knownChangedPaths) || knownChangedPaths.length === 0) {
    return null;
  }

  const changedSegments = [];
  for (const pathKey of knownChangedPaths) {
    if (typeof pathKey !== "string" || !pathKey.startsWith("/")) {
      return null;
    }
    const segments = getSegments(pathKey);
    if (segments.length === 0) {
      return null;
    }
    changedSegments.push(segments);
  }
  return changedSegments;
}

function markRootWriteDirty(table, changedSegments) {
  if (!changedSegments) {
    markRowDirty(table, []);
    return;
  }
  for (const segments of changedSegments) {
    markRowDirty(table, segments);
    if (fullDirty.has(table)) {
      return;
    }
  }
}

// A failed multi-row compensation must not leak a partial preimage through a
// debounce, explicit fence or shutdown. The owning service retains its release
// handle until every compensation row has been staged coherently.
function holdTableFlush(table) {
  persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "hold flush");
  assertPersistenceOwnerHealthy();
  tableFlushHolds.set(table, (tableFlushHolds.get(table) || 0) + 1);
  if (flushTimers[table]) clearTimeout(flushTimers[table]);
  delete flushTimers[table];
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = tableFlushHolds.get(table) - 1;
    if (remaining > 0) tableFlushHolds.set(table, remaining);
    else {
      tableFlushHolds.delete(table);
      if (dirty.has(table)) scheduleFlush(table);
    }
  };
}

function scheduleFlush(table) {
  dirty.add(table);

  if (flushTimers[table]) {
    clearTimeout(flushTimers[table]);
  }
  if (tableFlushHolds.has(table)) {
    delete flushTimers[table];
    return;
  }

  flushTimers[table] = setTimeout(() => {
    flushTable(table);
  }, FLUSH_DELAY_MS);
}

function flushTable(table) {
  if (tableFlushHolds.has(table)) return;
  if (!dirty.has(table)) return;
  dirty.delete(table);
  if (flushTimers[table]) {
    clearTimeout(flushTimers[table]);
  }
  delete flushTimers[table];

  try {
    persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "flush");
    assertPersistenceOwnerHealthy();
    if (isSqliteTable(table)) {
      flushSqliteTable(table);
      return;
    }
    const data = buildFlushSnapshot(table);
    const json = JSON.stringify(data, null, 2);
    safeWriteFileSync(dataFilePath(table), json);
  } catch (err) {
    dbErr(`flush FAILED for ${table}: ${err.message}`);
    dirty.add(table);
  }
}

function reconcileInFlightFlush(table) {
  const inFlight = inFlightFlushes.get(table);
  if (!inFlight) {
    return false;
  }
  const reconciled = inFlight.submittedToWorker
    ? persistenceWorker.reconcileWrite(SQLITE_DB_PATH, inFlight.operationId)
    : sqliteStore.reconcilePersistenceOperation(
      inFlight.operationId,
      table,
      requirePersistenceOwnerFence(),
    );
  // The controller normally invokes the acknowledgment callback itself. Keep
  // this fallback explicit for injected controllers used by focused tests.
  if (inFlightFlushes.get(table) === inFlight) {
    handlePersistenceWorkerAcknowledged(reconciled || inFlight);
  }
  const remaining = inFlightFlushes.get(table);
  if (remaining && remaining.operationId === inFlight.operationId) {
    throw new Error(
      `persistence operation ${inFlight.operationId} remained unresolved after reconciliation`,
    );
  }
  return true;
}

function flushTableSync(table, options = {}) {
  persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "flush");
  assertPersistenceOwnerHealthy();
  if (tableFlushHolds.has(table)) {
    return { success: false, errorMsg: "TABLE_FLUSH_HELD", flushed: false };
  }
  if (!ensureCached(table)) {
    log.warn(`[DATABASE] database table: '${table}' not found!`);
    return { success: false, errorMsg: "TABLE_NOT_FOUND" };
  }

  if (flushTimers[table]) {
    clearTimeout(flushTimers[table]);
    delete flushTimers[table];
  }

  try {
    const sqliteTable = isSqliteTable(table);
    if (sqliteTable) {
      // A same-process close/reopen must route durable recovery through the
      // controller before either worker-bound or direct in-flight reconciliation
      // touches the connection.
      ensureSqliteReady();
    }
    const reconciled = sqliteTable ? reconcileInFlightFlush(table) : false;
    if (!dirty.has(table)) {
      return { success: true, errorMsg: null, flushed: reconciled };
    }
    if (sqliteTable) {
      // sync: true reconciles directly on the main connection. Any earlier
      // async operation was resolved above before a newer diff was computed.
      flushSqliteTable(table, { sync: true });
    } else {
      safeWriteFileSync(
        dataFilePath(table),
        JSON.stringify(buildFlushSnapshot(table), null, 2),
      );
    }
    dirty.delete(table);
    if (options.log === true) {
      dbLog(`  ${pc.cyan(table)} ${pc.green("flushed")}`);
    }
    return { success: true, errorMsg: null, flushed: true };
  } catch (err) {
    dbErr(`sync flush FAILED for ${table}: ${err.message}`);
    dirty.add(table);
    return { success: false, errorMsg: "FLUSH_ERROR", flushed: false };
  }
}

function flushTablesSync(tables = []) {
  if (PROCESS_ROLE === persistenceRoles.ROLE.READER) {
    persistenceRoles.assertRoleMayMutateTable(
      PROCESS_ROLE,
      "__all_tables__",
      "flush",
    );
  }
  const uniqueTables = [...new Set(
    (Array.isArray(tables) ? tables : [tables]).filter((table) => Boolean(table)),
  )];
  const results = [];
  let success = true;

  for (const table of uniqueTables) {
    renewPersistenceOwnerLeaseAtBoundary();
    const result = flushTableSync(table);
    renewPersistenceOwnerLeaseAtBoundary();
    results.push({ table, ...result });
    if (!result.success) {
      success = false;
    }
  }

  return {
    success,
    results,
  };
}

/**
 * Synchronously flush ALL dirty tables.  Called on shutdown so
 * nothing is lost when the process exits.
 */
function flushAllSync() {
  if (PROCESS_ROLE === persistenceRoles.ROLE.READER) {
    persistenceRoles.assertRoleMayMutateTable(
      PROCESS_ROLE,
      "__all_tables__",
      "flush",
    );
  }
  const dirtyTables = [...new Set([...dirty, ...inFlightFlushes.keys()])];
  const results = [];
  if (dirtyTables.length === 0) {
    return { success: true, results };
  }

  dbLog(`shutdown flush — writing ${dirtyTables.length} dirty table(s)...`);

  let success = true;
  for (const table of dirtyTables) {
    let result;
    try {
      renewPersistenceOwnerLeaseAtBoundary();
      result = flushTableSync(table, { log: true });
      renewPersistenceOwnerLeaseAtBoundary();
    } catch (error) {
      dbErr(`shutdown flush FAILED for ${table}: ${error.message}`);
      dirty.add(table);
      result = {
        success: false,
        errorMsg: error.code || "FLUSH_ERROR",
        flushed: false,
      };
    }
    results.push({ table, ...result });
    if (!result.success) {
      success = false;
      dbErr(`shutdown flush FAILED for ${table}: ${result.errorMsg || "FLUSH_ERROR"}`);
    }
  }

  if (success) {
    dbLog(pc.green("shutdown flush complete"));
  } else {
    dbErr("shutdown flush incomplete — unresolved durable state remains");
  }
  return { success, results };
}

// ── Graceful shutdown ───────────────────────────────────────────────

let shutdownInProgress = false;
let signalShutdownPromise = null;
let shutdownFlushResult = null;
let gameStoreShutdownPromise = null;
const shutdownHooks = new Map();
const SHUTDOWN_HOOK_TIMEOUT_MS = 10_000;

// True once a shutdown has started. Writes are refused from then on, so
// deferred work that would write can stop instead of throwing.
function isShutdownInProgress() {
  return shutdownInProgress;
}

function registerShutdownHook(name, handler) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName || typeof handler !== "function") {
    throw new TypeError("shutdown hooks require a name and function");
  }
  if (shutdownHooks.has(normalizedName)) {
    throw new Error(`shutdown hook already registered: ${normalizedName}`);
  }
  shutdownHooks.set(normalizedName, handler);
  return () => shutdownHooks.delete(normalizedName);
}

async function runShutdownHooks(signal) {
  const results = [];
  let success = true;
  for (const [name, handler] of shutdownHooks.entries()) {
    let timeoutHandle = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => handler(signal)),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`timed out after ${SHUTDOWN_HOOK_TIMEOUT_MS}ms`));
          }, SHUTDOWN_HOOK_TIMEOUT_MS);
        }),
      ]);
      results.push({ name, success: true, error: null });
    } catch (error) {
      dbWarn(`shutdown hook ${name} failed: ${error.message}`);
      success = false;
      results.push({ name, success: false, error: error.message });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
  return { success, results };
}

function flushDirtyTablesForShutdown(reason) {
  if (shutdownInProgress) {
    return shutdownFlushResult || { success: false, results: [] };
  }
  shutdownInProgress = true;
  dbLog(`received ${reason}, flushing cache to disk...`);
  shutdownFlushResult = flushAllSync();
  return shutdownFlushResult;
}

function persistenceWorkerShutdownSucceeded(result) {
  return Boolean(
    result &&
    !result.error &&
    (!Array.isArray(result.errors) || result.errors.length === 0) &&
    (!Array.isArray(result.writeErrors) || result.writeErrors.length === 0) &&
    (result.active !== true || result.terminated === true),
  );
}

function shutdown(reason = "shutdown") {
  if (gameStoreShutdownPromise) return gameStoreShutdownPromise;
  if (!OWNS_PERSISTENCE) {
    shutdownInProgress = true;
    const flush = { success: true, results: [], passive: true };
    gameStoreShutdownPromise = Promise.resolve({
      success: true,
      code: null,
      errorMsg: null,
      flush,
      results: flush.results,
      worker: null,
      released: false,
      passive: true,
      reason,
    });
    return gameStoreShutdownPromise;
  }
  gameStoreShutdownPromise = (async () => {
    const flush = flushDirtyTablesForShutdown(reason);
    let worker = null;
    let released = false;
    let error = null;

    try {
      worker = await persistenceWorker.shutdown();
      if (!persistenceWorkerShutdownSucceeded(worker)) {
        throw persistenceOwnerError(
          worker && worker.error || "persistence worker shutdown failed",
          "PERSISTENCE_WORKER_SHUTDOWN_FAILED",
        );
      }
      if (flush.success && persistenceWorker.getOwnerFence()) {
        released = persistenceWorker.releaseOwner(SQLITE_DB_PATH);
        if (!released) {
          throw persistenceOwnerError(
            "persistence owner release returned false",
            "PERSISTENCE_OWNER_RELEASE_FAILED",
          );
        }
        persistenceOwnerFence = null;
        stopPersistenceOwnerRenewal();
      }
    } catch (shutdownError) {
      error = persistenceOwnerError(
        shutdownError,
        "GAMESTORE_SHUTDOWN_FAILED",
      );
      dbErr(`shutdown finalization failed: ${error.message}`);
    }

    const success = Boolean(flush.success && !error);
    return {
      success,
      code: success ? null : error && error.code || "GAMESTORE_SHUTDOWN_FAILED",
      errorMsg: success ? null : error && error.message ||
        "GameStore shutdown left unresolved durable state",
      flush,
      results: flush.results,
      worker,
      released,
    };
  })();
  return gameStoreShutdownPromise;
}

// Runs the registered shutdown hooks, then shuts the store down, for a process
// stopping on a signal or a lost lease. It never touches the process: the
// entry point that owns the process turns the result into an exit code
// (ownerProcessShutdown.js). Repeated calls share the first run.
function shutdownForSignal(signal) {
  if (signalShutdownPromise) {
    return signalShutdownPromise;
  }
  signalShutdownPromise = (async () => {
    dbLog(`received ${signal}, stopping registered runtimes...`);
    const hooks = await runShutdownHooks(signal);
    const store = await shutdown(signal);
    return { success: Boolean(hooks.success && store.success), hooks, store };
  })().catch((error) => {
    dbWarn(`graceful shutdown failed: ${error.message}`);
    flushDirtyTablesForShutdown(`${signal}-fallback`);
    return { success: false, error };
  });
  return signalShutdownPromise;
}

// What an exiting process still owes the store: writes not yet on disk, and
// whether it still holds the persistence owner lease.
function getShutdownNeeds() {
  return {
    unflushedWrites: dirty.size > 0 || inFlightFlushes.size > 0,
    holdsOwnerLease: Boolean(persistenceWorker.getOwnerFence()),
  };
}

// ── Public API (unchanged signature) ────────────────────────────────

function ensureCached(table) {
  if (!(table in cache)) {
    if (isSqliteTable(table)) {
      loadTable(table);
      return true;
    }
    const tableDir = path.join(DATA_DIR, table);
    if (!fs.existsSync(tableDir)) {
      return false;
    }
    loadTable(table);
  }
  return true;
}

function tableExists(table) {
  if (table in cache || isSqliteTable(table)) {
    return true;
  }
  return roleMayPublishTable(table)
    ? fs.existsSync(path.join(DATA_DIR, table))
    : fs.existsSync(dataFilePath(table));
}

// Bootstrap a runtime-owned table that may not have been created by the
// database builder yet (e.g. a newly added pending-payout ledger). loadTable
// creates the directory and an empty {} data file on demand, so subsequent
// read/write calls resolve normally instead of failing with TABLE_NOT_FOUND.
function ensureTable(table) {
  persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "ensure");
  assertPersistenceOwnerHealthy();
  if (shutdownInProgress) {
    throw new Error("gameStore shutdown is in progress");
  }
  if (!(table in cache)) {
    loadTable(table);
  }
  return true;
}

function read(table, pth) {
  if (!ensureCached(table)) {
    log.warn(`[DATABASE] database table: '${table}' not found!`);
    return { success: false, errorMsg: "TABLE_NOT_FOUND", data: null };
  }

  try {
    const segments = getSegments(pth);
    const db = cache[table];

    if (segments.length === 0) {
      return { success: true, errorMsg: null, data: db };
    }

    let current = db;
    for (const segment of segments) {
      if (
        current === null ||
        typeof current !== "object" ||
        !(segment in current)
      ) {
        return { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
      }
      current = current[segment];
    }

    return { success: true, errorMsg: null, data: current };
  } catch (error) {
    log.error(`[DATABASE READ ERROR] ${error.message}`);
    return { success: false, errorMsg: "READ_ERROR", data: null };
  }
}

// Read the current durable SQLite value without consulting or populating this
// process's in-memory cache. Cross-process authorities use this only for
// one-time compatibility seeding: a cached read would never observe an entity
// created later by the owning process, while importing that owner's service
// module here would also grant this process accidental write authority.
function readPersisted(table, pth) {
  if (!isSqliteTable(table)) {
    return { success: false, errorMsg: "SQLITE_TABLE_REQUIRED", data: null };
  }
  try {
    ensureSqliteReady();
    const segments = getSegments(pth);
    const selected = segments.length
      ? sqliteStore.loadExistingTablePath(table, segments)
      : { exists: true, value: sqliteStore.loadExistingTableObject(table) };
    if (!selected.exists) return { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
    return {
      success: true,
      errorMsg: null,
      // Durable selection parses fresh JSON rows on every call, so the
      // selected value is already isolated from the cache and other readers.
      // Serializing it again would impose a per-string limit on whole tables.
      data: selected.value,
    };
  } catch (error) {
    log.error(`[DATABASE DURABLE READ ERROR] ${error.message}`);
    return {
      success: false,
      errorMsg: error && error.code === "SQLITE_TABLE_NOT_FOUND"
        ? error.code
        : "READ_ERROR",
      data: null,
    };
  }
}

function readPersistedAbyssalInstances(characterID = 0) {
  try {
    ensureSqliteReady();
    return { success: true, errorMsg: null, data: sqliteStore.loadExistingAbyssalInstances(characterID) };
  } catch (error) {
    log.error(`[DATABASE DURABLE ABYSSAL READ ERROR] ${error.message}`);
    return { success: false, errorMsg: error?.code === "SQLITE_TABLE_NOT_FOUND" ? error.code : "READ_ERROR", data: null };
  }
}

function readPersistedIncursionPending(table, instanceID) {
  try {
    ensureSqliteReady();
    return { success: true, errorMsg: null, data: sqliteStore.loadExistingIncursionPending(table, instanceID) };
  } catch (error) {
    if (error?.code === "SQLITE_TABLE_NOT_FOUND") return { success: true, errorMsg: null, data: [] };
    log.error(`[DATABASE DURABLE INCURSION READ ERROR] ${error.message}`);
    return { success: false, errorMsg: "READ_ERROR", data: null };
  }
}

function readPersistedCareerRows(table, characterID) {
  try {
    ensureSqliteReady();
    return { success: true, errorMsg: null, data: sqliteStore.loadExistingCareerRows(table, characterID) };
  } catch (error) {
    log.error(`[DATABASE DURABLE CAREER READ ERROR] ${error.message}`);
    return { success: false, errorMsg: error?.code === "SQLITE_TABLE_NOT_FOUND" ? error.code : "READ_ERROR", data: null };
  }
}

function write(table, pth, data, options = {}) {
  const passiveTransientWrite =
    PROCESS_ROLE === persistenceRoles.ROLE.READER &&
    options.transient === true &&
    options.force !== true;
  if (!passiveTransientWrite) {
    persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "write");
    assertPersistenceOwnerHealthy();
  }
  if (shutdownInProgress) {
    throw new Error("gameStore shutdown is in progress");
  }
  if (!ensureCached(table)) {
    log.warn(`[DATABASE] database table: '${table}' not found!`);
    return { success: false, errorMsg: "TABLE_NOT_FOUND" };
  }

  try {
    const segments = getSegments(pth);

    if (segments.length === 0) {
      // Full table overwrite
      const sameReference = cache[table] === data;
      const changedSegments = getKnownRootWriteSegments(options.knownChangedPaths);
      const unchanged = !sameReference && !changedSegments && options.force !== true &&
        isSameValue(cache[table], data);
      if (options.transient === true) {
        setTransientPath(table, "/", true);
      }
      if (unchanged) {
        return { success: true, errorMsg: null };
      }
      if (!sameReference) {
        cache[table] = data;
      }
      if (!(options.transient === true && options.force !== true)) {
        markRootWriteDirty(table, changedSegments);
        scheduleFlush(table);
      }
      return { success: true, errorMsg: null };
    }

    let current = cache[table];
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (
        !(segment in current) ||
        current[segment] === null ||
        typeof current[segment] !== "object"
      ) {
        current[segment] = {};
      }
      current = current[segment];
    }

    if (options.transient === true) {
      setTransientPath(table, pth, true);
    }
    const finalKey = segments[segments.length - 1];
    if (Object.prototype.hasOwnProperty.call(current, finalKey) && isSameValue(current[finalKey], data)) {
      return { success: true, errorMsg: null };
    }
    current[finalKey] = data;
    if (!(options.transient === true && options.force !== true)) {
      markRowDirty(table, segments);
      scheduleFlush(table);
    }

    return { success: true, errorMsg: null };
  } catch (error) {
    log.error(`[DATABASE WRITE ERROR] ${error.message}`);
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
}

function remove(table, pth) {
  persistenceRoles.assertRoleMayMutateTable(PROCESS_ROLE, table, "remove from");
  assertPersistenceOwnerHealthy();
  if (shutdownInProgress) {
    throw new Error("gameStore shutdown is in progress");
  }
  if (!ensureCached(table)) {
    log.warn(`[DATABASE] database table: '${table}' not found!`);
    return { success: false, errorMsg: "TABLE_NOT_FOUND" };
  }

  try {
    const segments = getSegments(pth);

    if (segments.length === 0) {
      return { success: false, errorMsg: "INVALID_PATH" };
    }

    let current = cache[table];
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (
        current === null ||
        typeof current !== "object" ||
        !(segment in current)
      ) {
        return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
      }
      current = current[segment];
    }

    const finalKey = segments[segments.length - 1];
    if (
      current === null ||
      typeof current !== "object" ||
      !(finalKey in current)
    ) {
      return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
    }

    delete current[finalKey];
    clearTransientPathsForPrefixes(table, [pth]);
    markRowDirty(table, segments);
    scheduleFlush(table);

    return { success: true, errorMsg: null };
  } catch (error) {
    log.error(`[DATABASE DELETE ERROR] ${error.message}`);
    return { success: false, errorMsg: "DELETE_ERROR" };
  }
}

module.exports = {
  read,
  readPersisted,
  readPersistedAbyssalInstances,
  readPersistedIncursionPending,
  readPersistedKillmailsForCharacter: characterID => readPersistedCareerRows("killmails", characterID),
  readPersistedIndustryJobsForCharacter: characterID => readPersistedCareerRows("industryJobs", characterID),
  readPersistedPendingCareerCombatOutcomes: characterID => readPersistedCareerRows("items", characterID),
  holdTableFlush,
  write,
  remove,
  tableExists,
  ensureTable,
  mayMutateTable,
  setTransientPath,
  setTransientPaths,
  isTransientPath,
  preloadAll,
  // Requests the normal worker-backed flush immediately instead of waiting for
  // the debounce. When no same-table operation is already in flight, the exact
  // SQLite operation is journaled synchronously and the transaction remains
  // off-thread when enabled.
  flushTableAsync: flushTable,
  flushTableSync,
  flushTablesSync,
  flushAllSync,
  acquirePersistenceOwnerLease,
  renewPersistenceOwnerLease: renewPersistenceOwnerLeaseNow,
  shutdown,
  flushDirtyTablesForShutdown,
  shutdownForSignal,
  getShutdownNeeds,
  isShutdownInProgress,
  onPersistenceOwnerLost,
  registerShutdownHook,
  // Internal hooks for migration tooling and tests.
  _dataDir: DATA_DIR,
  _sqliteDbPath: SQLITE_DB_PATH,
  _sqliteTables: SQLITE_TABLES,
  _closeSqliteForTests: sqliteStore.close,
  // Runs the normal debounced (worker-bound) flush immediately. Lets a test put
  // a properly tracked operation in flight without waiting out FLUSH_DELAY_MS or
  // fabricating a raw persistenceWorker.submitWrite the store never registered.
  _flushTableAsyncForTests: flushTable,
  _shutdownPersistenceWorkerForTests: persistenceWorker.shutdown,
  _runShutdownHooksForTests: runShutdownHooks,
  _flushStatsForTests: flushStats,
  _dirtyRowTrackingEnabled: DIRTY_ROWS_TRACKING,
  _isTableDirtyForTests: (table) => dirty.has(table),
  _processRole: PROCESS_ROLE,
  _persistenceOwnerInstance: PERSISTENCE_OWNER_INSTANCE,
  _persistenceOwnerAcquireWaitMs: PERSISTENCE_OWNER_ACQUIRE_WAIT_MS,
  _persistenceOwnerFenceForTests: () => (
    persistenceWorker.getOwnerFence()
  ),
  _renewPersistenceOwnerForTests: renewPersistenceOwnerLeaseNow,
};
