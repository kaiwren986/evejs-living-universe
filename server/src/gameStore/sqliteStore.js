"use strict";

/**
 * SQLITE PERSISTENCE BACKEND (proof-of-concept):
 *
 * A thin key/value-blob store used as the on-disk backend for selected
 * runtime tables, in place of one big data.json file per table.
 *
 * Each logical table maps to one SQL table with the shape:
 *     "<table>"(key TEXT PRIMARY KEY, json TEXT NOT NULL)
 * i.e. one row per top-level entity, with the entity record stored as a
 * JSON blob. This keeps the existing nested-object cache semantics in
 * server/src/gameStore/index.js completely intact — SQLite is only the
 * durable container — while giving us:
 *   - ACID writes (no more whole-file-rewrite corruption window), and
 *   - per-row upserts (a change to one character no longer rewrites the
 *     entire table file).
 *
 * The store is intentionally tiny and synchronous (better-sqlite3) so it
 * slots in behind the existing synchronous read/write/remove API without
 * forcing any consumer to become async.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const storeRoot = require("./storeRoot");
const persistenceLeasePolicy = require("./persistenceLeasePolicy");

let Database = null;
let db = null;
let dbPath = null;
let dbReadOnly = false;

// SQL identifiers are interpolated into DDL/DML, so hard-fail on anything
// that is not a plain table name. Every real table name is camelCase ascii.
const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;
const INTERNAL_TABLE_NAMES = new Set([
  "_migrations",
  "_persistence_outbox",
  "_persistence_owners",
]);

const LEGACY_PERSISTENCE_OWNER_ROLE = "__legacy__";
const STANDALONE_PERSISTENCE_OWNER_ROLE = "standalone";
const DEFAULT_PERSISTENCE_OWNER_LEASE_MS =
  persistenceLeasePolicy.DEFAULT_LEASE_MS;
const MIN_PERSISTENCE_OWNER_LEASE_MS = persistenceLeasePolicy.MIN_LEASE_MS;
const PERSISTENCE_OWNER_ROLE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
let standalonePersistenceOwnerFence = null;

const ensuredTables = new Set();
const upsertStatements = new Map();
const deleteStatements = new Map();

function assertSafeTableName(table) {
  if (!SAFE_TABLE_NAME.test(String(table || ""))) {
    throw new Error(`unsafe sqlite table name: ${JSON.stringify(table)}`);
  }
  return table;
}

// ── Nested-row ("wrapper") tables ───────────────────────────────────
// Most tables are flat: each top-level key is an entity, stored one row per
// key. A few tables nest their entities one level under a named group (e.g.
// notifications.boxes[characterID], wormholeRuntimeState.pairsByID[pairID]).
// For those, storing the whole group as one row means a change to a single
// entity rewrites the entire group blob. Opt a table in here and its entities
// are stored one row per entity (key "group\u001fentityID"), so one change is
// one small row. Everything not listed is unchanged (flat).
const ROW_GROUPS = {
  items: ["__evejsInventoryGrantReceipts"],
  notifications: ["boxes"],
  miningRuntimeState: ["systems"],
  wormholeRuntimeState: ["pairsByID", "staticSlotsByKey", "polarizationByCharacter"],
  alliances: ["records"],
  bookmarkFolders: ["records"],
  bookmarkGroups: ["records"],
  bookmarkKnownFolders: ["recordsByCharacterID"],
  bookmarks: ["records"],
  calendarEvents: ["events"],
  calendarResponses: ["responses"],
  characterEnergyState: ["characters"],
  corporationBills: ["bills", "automaticPaySettingsByOwner"],
  corporationGoals: ["goalsByID"],
  corporationRuntime: [
    "corporations", "alliances", "wars", "warNegotiations",
    "mutualWarInvites", "mutualWarInviteBlocks", "peaceTreaties",
  ],
  dungeonRuntimeState: ["instancesByID"],
  homefrontReplay: ["operations", "receipts", "pending"],
  industryBlueprintState: ["records"],
  industryJobs: ["jobs"],
  industryRuntime: ["monitors"],
  insuranceContracts: ["contractsByShipID", "contractHistoryByID", "payoutLedgerByLossID"],
  lpWallets: ["characterWallets", "corporationWallets"],
  miningLedger: ["characters", "observers"],
  killRights: ["rights", "activations"],
  killmails: ["records", "pending"],
  mail: ["messages", "mailboxes", "mailingLists"],
  mapTelemetry: ["visitsByCharacterID"],
  missionRuntimeState: ["charactersByID"],
  researchRuntimeState: ["charactersByID"],
  moduleGroupingState: ["ships"],
  moonExtractions: ["resourcesByStructureID", "extractions"],
  npcEntities: ["entities"],
  npcModules: ["modules"],
  npcRuntimeControllers: ["controllers"],
  overviewSharedPresets: ["entries"],
  planetOrbitalState: ["orbitalsByID"],
  planetRuntimeState: [
    "resourcesByPlanetID", "coloniesByKey", "launchesByID", "acceptedNetworkEditsByKey",
    "networkEditReceiptsByKey",
  ],
  playerBounties: ["pools", "contributions", "hunterStats"],
  rafflesRuntime: ["reservations"],
  repairOperations: ["operationsByID"],
  savedFittings: ["owners"],
  sharedSettings: ["entries"],
  shipCosmetics: ["characters", "ships"],
  shipDirt: ["ships"],
  shipKillCounters: ["ships"],
  solarSystemInterferenceState: ["systems"],
  sovereignty: ["alliances", "systems", "hubs", "skyhooks", "mercenaryDens", "resources"],
  structurePaintwork: ["catalogueByTypeID", "licensesByID", "structureAssignments"],
  structureProfiles: ["profilesByID"],
  structureTetherRestrictions: ["restrictions"],
  // Empty today; wrapper shapes confirmed from each owning service's defaults.
  bookmarkSubfolders: ["records", "recordsByCharacterID"],
  corporationVotes: ["corporations"],
  evermarkEntitlements: ["characters"],
  pendingNpcBounties: ["npcTypes"],
  dynamicResourceRuntime: ["systems", "funding", "settlements", "unlocks", "losses"],
  probeRuntimeState: ["probesByID"],
  shipLogoFittings: ["ships"],
  chatState: ["channels", "privateChannelByPair"],
  chatStaticContracts: ["observations"],
  chatBacklog: ["entriesByRoomName"],
  abyssalRecoveryTombstones: [
    "byCharacterID",
    "byShipID",
    "byHostLocationID",
  ],
};
const ROW_KEY_SEP = "\u001f";

function rowGroupsFor(table) {
  return ROW_GROUPS[table] || null;
}

/**
 * Flatten a nested table object into the `{ rowKey: value }` map actually
 * stored as SQLite rows. For a configured group it emits one row per entity
 * (`group\u001fentityID`) plus a skeleton `group` row, so a group that is
 * present but empty still round-trips. Flat tables pass through unchanged.
 */
function explodeToRows(table, object = {}) {
  const groups = rowGroupsFor(table);
  const rows = {};
  for (const key of Object.keys(object || {})) {
    const value = object[key];
    const isGroup =
      groups &&
      groups.includes(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value);
    if (isGroup) {
      rows[key] = {}; // skeleton: records that the group exists (even if empty)
      for (const entityKey of Object.keys(value)) {
        if (String(entityKey).includes(ROW_KEY_SEP)) {
          throw new Error(
            `entity key contains reserved separator: ${table}.${key}.${entityKey}`,
          );
        }
        rows[`${key}${ROW_KEY_SEP}${entityKey}`] = value[entityKey];
      }
    } else {
      rows[key] = value;
    }
  }
  return rows;
}

/**
 * Inverse of explodeToRows: rebuild the nested table object from the flat
 * `{ rowKey: value }` row map. Order-independent and lossless.
 */
function assembleFromRows(table, rows = {}) {
  const groups = new Set(rowGroupsFor(table) || []);
  const object = {};
  for (const rowKey of Object.keys(rows)) {
    const sepIndex = rowKey.indexOf(ROW_KEY_SEP);
    if (sepIndex >= 0) {
      const group = rowKey.slice(0, sepIndex);
      const entityKey = rowKey.slice(sepIndex + 1);
      if (!object[group] || typeof object[group] !== "object") {
        object[group] = {};
      }
      object[group][entityKey] = rows[rowKey];
    } else if (groups.has(rowKey)) {
      // Group container row. In the per-entity format this is an empty skeleton.
      // A not-yet-reconverted install may still hold the whole group blob here
      // (from before the split) — merge it in without clobbering per-entity rows,
      // so the first flush cleanly converts it.
      const blob =
        rows[rowKey] && typeof rows[rowKey] === "object" && !Array.isArray(rows[rowKey])
          ? rows[rowKey]
          : {};
      object[rowKey] = { ...blob, ...(object[rowKey] || {}) };
    } else {
      object[rowKey] = rows[rowKey];
    }
  }
  return object;
}

/**
 * Resolve the value of a SINGLE stored row directly from a nested table object,
 * without exploding the whole table. This is the per-row counterpart to
 * explodeToRows used by the gameStore dirty-row flush fast path, and it MUST
 * mirror explodeToRows exactly:
 *   - `groupentity`  -> object[group][entity]   (the entity record)
 *   - bare group key       -> {}                       (the empty skeleton row)
 *   - flat / scalar key    -> object[key]
 *   - any absent key       -> undefined                (signals a deleted row)
 * The equivalence to explodeToRows()[rowKey] is pinned by a guard test.
 */
function rowValueForKey(table, object, rowKey) {
  const source = object && typeof object === "object" ? object : {};
  const sepIndex = String(rowKey).indexOf(ROW_KEY_SEP);
  if (sepIndex >= 0) {
    const group = rowKey.slice(0, sepIndex);
    const entityKey = rowKey.slice(sepIndex + 1);
    const groupValue = source[group];
    if (
      groupValue &&
      typeof groupValue === "object" &&
      !Array.isArray(groupValue) &&
      Object.prototype.hasOwnProperty.call(groupValue, entityKey)
    ) {
      return groupValue[entityKey];
    }
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(source, rowKey)) {
    return undefined;
  }
  const value = source[rowKey];
  const groups = rowGroupsFor(table);
  const isGroup =
    groups &&
    groups.includes(rowKey) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value);
  return isGroup ? {} : value;
}

function persistenceOwnerError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizePersistenceOwnerRole(value, options = {}) {
  const role = String(value || "").trim();
  if (
    !role ||
    role.length > 128 ||
    !PERSISTENCE_OWNER_ROLE_PATTERN.test(role) ||
    (role === LEGACY_PERSISTENCE_OWNER_ROLE && options.allowLegacy !== true)
  ) {
    throw persistenceOwnerError(
      `invalid persistence owner role: ${JSON.stringify(value)}`,
      "PERSISTENCE_OWNER_ROLE_INVALID",
    );
  }
  return role;
}

function normalizePersistenceOwnerInstanceId(value) {
  const instanceId = String(value || "").trim();
  if (!instanceId || instanceId.length > 320) {
    throw persistenceOwnerError(
      "persistence owner instanceId must be a non-empty string no longer than 320 characters",
      "PERSISTENCE_OWNER_INSTANCE_INVALID",
    );
  }
  return instanceId;
}

function normalizePersistenceOwnerFence(value) {
  if (!value || typeof value !== "object") {
    throw persistenceOwnerError(
      "persistence operation requires an acquired owner fence",
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  const ownerRole = normalizePersistenceOwnerRole(
    value.ownerRole === undefined ? value.role : value.ownerRole,
  );
  const instanceId = normalizePersistenceOwnerInstanceId(
    value.instanceId === undefined ? value.ownerInstanceId : value.instanceId,
  );
  const epoch = Number(value.epoch === undefined ? value.ownerEpoch : value.epoch);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw persistenceOwnerError(
      "persistence owner epoch must be a positive safe integer",
      "PERSISTENCE_OWNER_EPOCH_INVALID",
    );
  }
  return { ownerRole, epoch, instanceId };
}

function copyPersistenceOwnerFence(value) {
  const fence = normalizePersistenceOwnerFence(value);
  const leaseExpiresAt = Number(value.leaseExpiresAt);
  return {
    ...fence,
    ...(Number.isSafeInteger(leaseExpiresAt) ? { leaseExpiresAt } : {}),
  };
}

function normalizePersistenceOwnerLeaseMs(value) {
  const leaseMs = value === undefined
    ? DEFAULT_PERSISTENCE_OWNER_LEASE_MS
    : Number(value);
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < MIN_PERSISTENCE_OWNER_LEASE_MS
  ) {
    throw persistenceOwnerError(
      `persistence owner leaseMs must be an integer of at least ${MIN_PERSISTENCE_OWNER_LEASE_MS}`,
      "PERSISTENCE_OWNER_LEASE_INVALID",
    );
  }
  return leaseMs;
}

function persistenceOutboxCreateSql(tableName = "_persistence_outbox") {
  assertSafeTableName(tableName);
  return `
    CREATE TABLE "${tableName}" (
      operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL UNIQUE,
      owner_role TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
      owner_instance_id TEXT NOT NULL,
      upserts_json TEXT NOT NULL,
      deletes_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'applied')),
      created_at TEXT NOT NULL,
      applied_at TEXT,
      CHECK (
        (owner_role = '${LEGACY_PERSISTENCE_OWNER_ROLE}' AND owner_epoch = 0) OR
        (owner_role <> '${LEGACY_PERSISTENCE_OWNER_ROLE}' AND owner_epoch > 0)
      )
    )
  `;
}

function ensurePersistenceSchema() {
  const connection = requireWritableDb();
  // Cluster peers can open the same database concurrently during startup.
  // Serialize inspection as well as DDL: checking the legacy columns before
  // acquiring the write lock would let a waiter rebuild the table a second
  // time after another process had already committed the migration.
  const ensure = connection.transaction(() => {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS _persistence_owners (
        owner_role TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        instance_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1)),
        lease_expires_at INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        released_at TEXT
      )
    `);
    const ownerColumns = new Set(
      connection
        .prepare("PRAGMA table_info('_persistence_owners')")
        .all()
        .map((column) => column.name),
    );
    if (!ownerColumns.has("exclusive")) {
      connection.exec(
        "ALTER TABLE _persistence_owners ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0 CHECK (exclusive IN (0, 1))",
      );
    }
    if (!ownerColumns.has("lease_expires_at")) {
      connection.exec(
        "ALTER TABLE _persistence_owners ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0",
      );
    }

    const existing = connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_persistence_outbox'",
      )
      .get();
    if (!existing) {
      connection.exec(persistenceOutboxCreateSql());
      return;
    }

    const columns = new Set(
      connection
        .prepare("PRAGMA table_info('_persistence_outbox')")
        .all()
        .map((column) => column.name),
    );
    const outboxOwnerColumns = [
      "owner_role",
      "owner_epoch",
      "owner_instance_id",
    ];
    if (outboxOwnerColumns.every((column) => columns.has(column))) {
      return;
    }
    if (outboxOwnerColumns.some((column) => columns.has(column))) {
      throw persistenceOwnerError(
        "persistence outbox has a partially migrated owner schema",
        "PERSISTENCE_OUTBOX_SCHEMA_INVALID",
      );
    }

    // The July 2026 journal had no owner columns. Preserve operation IDs and
    // global table uniqueness. Rows stay quarantined until their table's
    // explicit owner adopts them.
    connection.exec(
      'ALTER TABLE "_persistence_outbox" RENAME TO "_persistence_outbox_legacy_migration"',
    );
    connection.exec(persistenceOutboxCreateSql());
    connection
      .prepare(
        `INSERT INTO _persistence_outbox(
           operation_id, table_name, owner_role, owner_epoch, owner_instance_id,
           upserts_json, deletes_json, state, created_at, applied_at
         )
         SELECT operation_id, table_name, ?, 0, ?, upserts_json, deletes_json,
                state, created_at, applied_at
         FROM _persistence_outbox_legacy_migration
         ORDER BY operation_id ASC`,
      )
      .run(LEGACY_PERSISTENCE_OWNER_ROLE, "legacy-schema-migration");
    connection.exec('DROP TABLE "_persistence_outbox_legacy_migration"');
  });
  ensure.immediate();
}

function assertActivePersistenceOwner(ownerFence) {
  const fence = normalizePersistenceOwnerFence(ownerFence);
  const stored = requireDb()
    .prepare(
      `SELECT owner_role, epoch, instance_id, active, lease_expires_at
       FROM _persistence_owners WHERE owner_role = ?`,
    )
    .get(fence.ownerRole);
  if (
    !stored ||
    stored.active !== 1 ||
    stored.epoch !== fence.epoch ||
    stored.instance_id !== fence.instanceId ||
    stored.lease_expires_at <= Date.now()
  ) {
    throw persistenceOwnerError(
      `persistence owner ${fence.ownerRole} epoch ${fence.epoch} is stale or inactive`,
      "PERSISTENCE_OWNER_STALE",
      {
        ownerRole: fence.ownerRole,
        ownerEpoch: fence.epoch,
        leaseExpiresAt: stored ? stored.lease_expires_at : null,
      },
    );
  }
  return { ...fence, leaseExpiresAt: stored.lease_expires_at };
}

function assertPersistenceOwner(ownerFence) {
  return copyPersistenceOwnerFence(assertActivePersistenceOwner(ownerFence));
}

/**
 * Hold SQLite's immediate writer lock while revalidating an owner fence and
 * synchronously publishing already-staged sidecar files. A successor cannot
 * advance the durable epoch between the check and the final atomic rename.
 * Expiry is intentionally checked when the transaction begins; the lock then
 * prevents a takeover until the short publication callback completes.
 */
function withPersistenceOwnerPublicationSync(ownerFence, publish) {
  requireWritableDb();
  if (typeof publish !== "function") {
    throw new TypeError(
      "persistence owner publication requires a synchronous callback",
    );
  }
  const requestedFence = normalizePersistenceOwnerFence(ownerFence);
  const publication = requireDb().transaction(() => {
    const activeFence = assertActivePersistenceOwner(requestedFence);
    return publish(copyPersistenceOwnerFence(activeFence));
  });
  return publication.immediate();
}

function acquirePersistenceOwner(ownerRole, instanceId, options = {}) {
  requireWritableDb();
  const role = normalizePersistenceOwnerRole(ownerRole);
  const normalizedInstanceId = normalizePersistenceOwnerInstanceId(instanceId);
  const exclusive = options.exclusive === true || role === "maintenance";
  const forceTakeover =
    options.forceTakeover === true || options.forceExclusive === true;
  const leaseMs = normalizePersistenceOwnerLeaseMs(options.leaseMs);
  const nowMs = Date.now();
  const leaseExpiresAt = nowMs + leaseMs;
  const acquiredAt = new Date().toISOString();
  const acquire = requireDb().transaction(() => {
    const existing = requireDb()
      .prepare(
        `SELECT owner_role, epoch, instance_id, active, exclusive,
                lease_expires_at
         FROM _persistence_owners WHERE owner_role = ?`,
      )
      .get(role);
    const existingLeaseIsLive = Boolean(
      existing &&
      existing.active === 1 &&
      existing.lease_expires_at > nowMs,
    );
    const sameLiveInstance = Boolean(
      existingLeaseIsLive && existing.instance_id === normalizedInstanceId,
    );
    if (
      existingLeaseIsLive &&
      !sameLiveInstance &&
      !forceTakeover
    ) {
      throw persistenceOwnerError(
        `persistence owner ${role} is active in another instance`,
        "PERSISTENCE_OWNER_ACTIVE",
        {
          ownerRole: role,
          ownerEpoch: existing.epoch,
          ownerInstanceId: existing.instance_id,
          leaseExpiresAt: existing.lease_expires_at,
        },
      );
    }

    const conflictingOwners = exclusive
      ? requireDb()
        .prepare(
          `SELECT owner_role, epoch, instance_id, exclusive, lease_expires_at
           FROM _persistence_owners
           WHERE active = 1 AND lease_expires_at > ? AND owner_role <> ?
           ORDER BY owner_role ASC`,
        )
        .all(nowMs, role)
      : requireDb()
        .prepare(
          `SELECT owner_role, epoch, instance_id, exclusive, lease_expires_at
           FROM _persistence_owners
           WHERE active = 1 AND lease_expires_at > ?
             AND exclusive = 1 AND owner_role <> ?
           ORDER BY owner_role ASC`,
        )
        .all(nowMs, role);
    if (conflictingOwners.length > 0 && options.forceExclusive !== true) {
      throw persistenceOwnerError(
        `persistence owner ${role} conflicts with active ` +
          conflictingOwners.map((owner) => owner.owner_role).join(", "),
        "PERSISTENCE_OWNER_CONFLICT",
        { ownerRole: role, conflictingOwners },
      );
    }
    if (conflictingOwners.length > 0) {
      // Reserved for a proven-offline maintenance transition. Mark every
      // conflicting lease inactive in the same transaction so their epochs
      // fail closed if a stale process resumes.
      requireDb()
        .prepare(
          `UPDATE _persistence_owners
           SET active = 0, lease_expires_at = 0, released_at = ?
           WHERE active = 1 AND lease_expires_at > ? AND owner_role <> ?`,
        )
        .run(acquiredAt, nowMs, role);
    }
    const epoch = sameLiveInstance
      ? existing.epoch
      : existing
        ? existing.epoch + 1
        : 1;
    requireDb()
      .prepare(
        `INSERT INTO _persistence_owners(
           owner_role, epoch, instance_id, active, exclusive,
           lease_expires_at, acquired_at, released_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, NULL)
         ON CONFLICT(owner_role) DO UPDATE SET
           epoch = excluded.epoch,
           instance_id = excluded.instance_id,
           active = 1,
           exclusive = excluded.exclusive,
           lease_expires_at = excluded.lease_expires_at,
           acquired_at = excluded.acquired_at,
           released_at = NULL`,
      )
      .run(
        role,
        epoch,
        normalizedInstanceId,
        exclusive ? 1 : 0,
        leaseExpiresAt,
        acquiredAt,
      );
    return {
      ownerRole: role,
      epoch,
      instanceId: normalizedInstanceId,
      leaseExpiresAt,
    };
  });
  return copyPersistenceOwnerFence(acquire.immediate());
}

function renewPersistenceOwner(ownerFence, options = {}) {
  requireWritableDb();
  const leaseMs = normalizePersistenceOwnerLeaseMs(options.leaseMs);
  const renew = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    const leaseExpiresAt = Date.now() + leaseMs;
    const result = requireDb()
      .prepare(
        `UPDATE _persistence_owners
         SET lease_expires_at = ?
         WHERE owner_role = ? AND epoch = ? AND instance_id = ?
           AND active = 1 AND lease_expires_at > ?`,
      )
      .run(
        leaseExpiresAt,
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        Date.now(),
      );
    if (result.changes !== 1) {
      throw persistenceOwnerError(
        `failed to renew persistence owner ${fence.ownerRole}`,
        "PERSISTENCE_OWNER_STALE",
        { ownerRole: fence.ownerRole, ownerEpoch: fence.epoch },
      );
    }
    return { ...fence, leaseExpiresAt };
  });
  return copyPersistenceOwnerFence(renew.immediate());
}

function releasePersistenceOwner(ownerFence) {
  requireWritableDb();
  const release = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    const result = requireDb()
      .prepare(
        `UPDATE _persistence_owners
         SET active = 0, lease_expires_at = 0, released_at = ?
         WHERE owner_role = ? AND epoch = ? AND instance_id = ? AND active = 1`,
      )
      .run(
        new Date().toISOString(),
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
      );
    if (result.changes !== 1) {
      throw persistenceOwnerError(
        `failed to release persistence owner ${fence.ownerRole}`,
        "PERSISTENCE_OWNER_RELEASE_FAILED",
      );
    }
    return true;
  });
  return release.immediate();
}

function ensureStandalonePersistenceOwner() {
  if (standalonePersistenceOwnerFence) {
    return assertActivePersistenceOwner(standalonePersistenceOwnerFence);
  }
  const implicitLiveDbPath = path.join(
    storeRoot.resolveStoreRoot(),
    "gamestore.sqlite",
  );
  if (
    process.env.EVEJS_TEST_STORE_ISOLATED !== "1" &&
    dbPath &&
    path.resolve(dbPath) === path.resolve(implicitLiveDbPath)
  ) {
    throw persistenceOwnerError(
      "refusing implicit standalone persistence ownership of the live gameStore; configure an explicit owner role",
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  standalonePersistenceOwnerFence = acquirePersistenceOwner(
    STANDALONE_PERSISTENCE_OWNER_ROLE,
    `standalone:${process.pid}:${crypto.randomUUID()}`,
    { forceTakeover: true },
  );
  return copyPersistenceOwnerFence(standalonePersistenceOwnerFence);
}

function resolvePersistenceOwnerFence(ownerFence) {
  return ownerFence === undefined || ownerFence === null
    ? ensureStandalonePersistenceOwner()
    : normalizePersistenceOwnerFence(ownerFence);
}

function adoptLegacyPersistenceOperations(ownerFence, tableNames) {
  requireWritableDb();
  if (!Array.isArray(tableNames)) {
    throw new TypeError(
      "legacy persistence adoption requires an explicit table-name array",
    );
  }
  const normalizedTables = [...new Set(
    tableNames.map((table) => normalizePersistenceTable(table)),
  )];
  const adopt = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(ownerFence);
    if (normalizedTables.length === 0) {
      return [];
    }
    const placeholders = normalizedTables.map(() => "?").join(", ");
    const rows = requireDb()
      .prepare(
        persistenceOperationSelectSql(
          `WHERE owner_role = ? AND table_name IN (${placeholders}) ` +
            "ORDER BY operation_id ASC",
        ),
      )
      .all(LEGACY_PERSISTENCE_OWNER_ROLE, ...normalizedTables);
    if (rows.length === 0) {
      return [];
    }
    requireDb()
      .prepare(
        `UPDATE _persistence_outbox
         SET owner_role = ?, owner_epoch = ?, owner_instance_id = ?
         WHERE owner_role = ? AND table_name IN (${placeholders})`,
      )
      .run(
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        LEGACY_PERSISTENCE_OWNER_ROLE,
        ...normalizedTables,
      );
    return rows.map((row) => parsePersistenceOperationRow({
      ...row,
      owner_role: fence.ownerRole,
      owner_epoch: fence.epoch,
      owner_instance_id: fence.instanceId,
    }));
  });
  return adopt.immediate();
}

/**
 * Open the backing SQLite database. Writable owners create/migrate the file
 * and use WAL. Passive readers use an existing file in SQLite's readonly plus
 * query_only modes and never execute schema or journal DDL.
 */
function init(targetPath, options = {}) {
  const normalizedPath = path.resolve(targetPath);
  const readOnly = options.readOnly === true;
  if (db && dbPath === normalizedPath && dbReadOnly === readOnly) {
    return db;
  }
  if (db) {
    close();
  }
  if (!Database) {
    Database = require("better-sqlite3");
  }
  if (!readOnly) {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  }
  try {
    db = new Database(
      normalizedPath,
      readOnly ? { readonly: true, fileMustExist: true } : undefined,
    );
    dbPath = normalizedPath;
    dbReadOnly = readOnly;
    db.pragma("busy_timeout = 5000");
    if (readOnly) {
      db.pragma("query_only = ON");
      return db;
    }
    // Install the lock wait before the WAL-setting PRAGMA itself can contend
    // with another process opening this shared database during cluster startup.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    // The persistence worker (when enabled) opens a SECOND connection to this
    // same WAL database. WAL serializes writers; busy_timeout waits through a
    // momentary peer transaction instead of surfacing SQLITE_BUSY.
    db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (table_name TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)",
    );
    // Durable handoff journal for asynchronous persistence writes. Operation
    // identities stay global and table_name remains globally UNIQUE.
    ensurePersistenceSchema();
    return db;
  } catch (error) {
    close();
    throw error;
  }
}

function isMigrated(table) {
  assertSafeTableName(table);
  return Boolean(
    requireDb().prepare("SELECT 1 FROM _migrations WHERE table_name = ?").get(table),
  );
}

function resolveDirectMutationFence(ownerFence) {
  // Legacy sqliteStore-only tests use disposable attested roots and predate
  // GameStore's controller fence. Production/offline callers must provide a
  // fence (or pass through the guarded implicit-standalone path, which refuses
  // the live store).
  if (
    (ownerFence === undefined || ownerFence === null) &&
    process.env.EVEJS_TEST_STORE_ISOLATED === "1"
  ) {
    return null;
  }
  return resolvePersistenceOwnerFence(ownerFence);
}

function assertDirectMutationOwner(requestedFence) {
  return requestedFence
    ? assertActivePersistenceOwner(requestedFence)
    : null;
}

function createSqlTable(table) {
  assertSafeTableName(table);
  requireWritableDb().exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  );
}

function markMigrated(table, ownerFence) {
  assertSafeTableName(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const mark = requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(table);
    requireWritableDb()
      .prepare(
        `INSERT INTO _migrations(table_name, migrated_at) VALUES (?, ?)
         ON CONFLICT(table_name) DO NOTHING`,
      )
      .run(table, new Date().toISOString());
  });
  mark.immediate();
  ensuredTables.add(table);
}

function requireDb() {
  if (!db) {
    throw new Error("sqliteStore.init(dbPath) must be called before use");
  }
  return db;
}

function requireWritableDb() {
  const connection = requireDb();
  if (dbReadOnly) {
    throw persistenceOwnerError(
      "SQLite store is open read-only; persistence mutation is forbidden",
      "SQLITE_STORE_READ_ONLY",
      { dbPath },
    );
  }
  return connection;
}

function ensureSqlTable(table) {
  assertSafeTableName(table);
  if (ensuredTables.has(table)) {
    return;
  }
  createSqlTable(table);
  ensuredTables.add(table);
}

function getUpsertStatement(table) {
  if (!upsertStatements.has(table)) {
    upsertStatements.set(
      table,
      requireDb().prepare(
        `INSERT INTO "${table}"(key, json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      ),
    );
  }
  return upsertStatements.get(table);
}

function getDeleteStatement(table) {
  if (!deleteStatements.has(table)) {
    deleteStatements.set(
      table,
      requireDb().prepare(`DELETE FROM "${table}" WHERE key = ?`),
    );
  }
  return deleteStatements.get(table);
}

function normalizePersistenceOperationId(operationId) {
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    throw new Error(
      `invalid persistence operation ID: ${JSON.stringify(operationId)}`,
    );
  }
  return operationId;
}

function normalizePersistenceTable(table, label = "persistence table") {
  if (typeof table !== "string") {
    throw new Error(`${label} must be a string`);
  }
  assertSafeTableName(table);
  if (INTERNAL_TABLE_NAMES.has(table.toLowerCase()) || /^sqlite_/i.test(table)) {
    throw new Error(`${label} may not name an internal SQLite table`);
  }
  return table;
}

function validatePersistenceUpserts(upserts, label = "persistence upserts") {
  if (!Array.isArray(upserts)) {
    throw new Error(`${label} must be an array`);
  }
  return upserts.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${label}[${index}] must be a [key, json] pair`);
    }
    const [key, json] = entry;
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}][0] must be a string key`);
    }
    if (typeof json !== "string") {
      throw new Error(`${label}[${index}][1] must be a JSON string`);
    }
    try {
      JSON.parse(json);
    } catch (error) {
      throw new Error(
        `${label}[${index}][1] is not valid JSON: ${error.message}`,
      );
    }
    return [key, json];
  });
}

function validatePersistenceDeletes(deletes, label = "persistence deletes") {
  if (!Array.isArray(deletes)) {
    throw new Error(`${label} must be an array`);
  }
  return deletes.map((key, index) => {
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}] must be a string key`);
    }
    return key;
  });
}

function parsePersistencePayload(raw, label, operationId) {
  if (typeof raw !== "string") {
    throw new Error(
      `persistence operation ${operationId} has a non-string ${label} payload`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `persistence operation ${operationId} has malformed ${label} JSON: ${error.message}`,
    );
  }
}

function parsePersistenceOperationRow(row) {
  if (!row) {
    return null;
  }
  const operationId = normalizePersistenceOperationId(row.operation_id);
  const table = normalizePersistenceTable(
    row.table_name,
    `persistence operation ${operationId} table`,
  );
  const ownerRole = normalizePersistenceOwnerRole(row.owner_role, {
    allowLegacy: true,
  });
  const ownerEpoch = Number(row.owner_epoch);
  const ownerInstanceId = normalizePersistenceOwnerInstanceId(
    row.owner_instance_id,
  );
  if (
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 0 ||
    (ownerRole === LEGACY_PERSISTENCE_OWNER_ROLE && ownerEpoch !== 0) ||
    (ownerRole !== LEGACY_PERSISTENCE_OWNER_ROLE && ownerEpoch <= 0)
  ) {
    throw new Error(
      `persistence operation ${operationId} has invalid owner epoch ${JSON.stringify(row.owner_epoch)}`,
    );
  }
  const upserts = validatePersistenceUpserts(
    parsePersistencePayload(row.upserts_json, "upserts", operationId),
    `persistence operation ${operationId} upserts`,
  );
  const deletes = validatePersistenceDeletes(
    parsePersistencePayload(row.deletes_json, "deletes", operationId),
    `persistence operation ${operationId} deletes`,
  );
  if (row.state !== "pending" && row.state !== "applied") {
    throw new Error(
      `persistence operation ${operationId} has invalid state: ${JSON.stringify(row.state)}`,
    );
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new Error(`persistence operation ${operationId} has invalid created_at`);
  }
  if (row.state === "pending" && row.applied_at !== null) {
    throw new Error(
      `pending persistence operation ${operationId} unexpectedly has applied_at`,
    );
  }
  if (
    row.state === "applied" &&
    (typeof row.applied_at !== "string" || row.applied_at.length === 0)
  ) {
    throw new Error(
      `applied persistence operation ${operationId} is missing applied_at`,
    );
  }
  return {
    operationId,
    table,
    ownerRole,
    ownerEpoch,
    ownerInstanceId,
    upserts,
    deletes,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

function persistenceOperationSelectSql(whereClause = "") {
  return `SELECT operation_id, table_name, owner_role, owner_epoch,
                 owner_instance_id, upserts_json, deletes_json,
                 state, created_at, applied_at
          FROM _persistence_outbox ${whereClause}`;
}

function assertPersistenceOperationOwner(operation, ownerFence) {
  if (operation.ownerRole !== ownerFence.ownerRole) {
    throw persistenceOwnerError(
      `persistence operation ${operation.operationId} belongs to ${operation.ownerRole}, not ${ownerFence.ownerRole}`,
      "PERSISTENCE_OPERATION_OWNER_MISMATCH",
      {
        operationId: operation.operationId,
        ownerRole: operation.ownerRole,
        expectedOwnerRole: ownerFence.ownerRole,
      },
    );
  }
  return operation;
}

function getPersistenceOperation(operationId, ownerFence) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  const fence = assertActivePersistenceOwner(
    resolvePersistenceOwnerFence(ownerFence),
  );
  const row = requireDb()
    .prepare(persistenceOperationSelectSql("WHERE operation_id = ?"))
    .get(normalizedId);
  const operation = parsePersistenceOperationRow(row);
  return operation ? assertPersistenceOperationOwner(operation, fence) : null;
}

function listPersistenceOperations(ownerFence) {
  const fence = assertActivePersistenceOwner(
    resolvePersistenceOwnerFence(ownerFence),
  );
  return requireDb()
    .prepare(
      persistenceOperationSelectSql(
        "WHERE owner_role = ? ORDER BY operation_id ASC",
      ),
    )
    .all(fence.ownerRole)
    .map(parsePersistenceOperationRow);
}

function listAllPersistenceOperations() {
  return requireDb()
    .prepare(persistenceOperationSelectSql("ORDER BY operation_id ASC"))
    .all()
    .map(parsePersistenceOperationRow);
}

/**
 * An exclusive maintenance owner may recover its own prior/adopted batches,
 * but it must never edit application rows while another logical owner's exact
 * batch remains journaled. That owner must recover the batch with its own
 * callback/baseline semantics first.
 */
function assertNoForeignPersistenceOperations(ownerFence) {
  requireWritableDb();
  const requestedFence = normalizePersistenceOwnerFence(ownerFence);
  const inspect = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const storedOwner = requireDb()
      .prepare(
        `SELECT exclusive FROM _persistence_owners
         WHERE owner_role = ? AND epoch = ? AND instance_id = ?`,
      )
      .get(fence.ownerRole, fence.epoch, fence.instanceId);
    if (
      fence.ownerRole !== "maintenance" ||
      !storedOwner ||
      storedOwner.exclusive !== 1
    ) {
      throw persistenceOwnerError(
        "foreign persistence operation inspection requires the active exclusive maintenance owner",
        "PERSISTENCE_MAINTENANCE_FENCE_REQUIRED",
        { ownerRole: fence.ownerRole, ownerEpoch: fence.epoch },
      );
    }
    const foreignOperations = requireDb()
      .prepare(
        `SELECT operation_id, table_name, owner_role, owner_epoch,
                owner_instance_id, state
         FROM _persistence_outbox
         WHERE owner_role <> ?
         ORDER BY operation_id ASC`,
      )
      .all(fence.ownerRole)
      .map((row) => ({
        operationId: Number(row.operation_id),
        table: row.table_name,
        ownerRole: row.owner_role,
        ownerEpoch: Number(row.owner_epoch),
        ownerInstanceId: row.owner_instance_id,
        state: row.state,
      }));
    if (foreignOperations.length > 0) {
      const diagnostic = foreignOperations
        .map((operation) =>
          `${operation.ownerRole}:${operation.table}#${operation.operationId}`)
        .join(", ");
      throw persistenceOwnerError(
        `exclusive maintenance is blocked by ${foreignOperations.length} ` +
          `foreign persistence operation${foreignOperations.length === 1 ? "" : "s"}: ` +
          diagnostic,
        "PERSISTENCE_FOREIGN_OPERATIONS_PENDING",
        {
          ownerRole: fence.ownerRole,
          ownerEpoch: fence.epoch,
          foreignOperations,
        },
      );
    }
    return true;
  });
  return inspect.immediate();
}

function assertExpectedPersistenceTable(operation, expectedTable) {
  const normalizedTable = normalizePersistenceTable(
    expectedTable,
    "expected persistence table",
  );
  if (operation.table !== normalizedTable) {
    throw new Error(
      `persistence operation ${operation.operationId} targets ${operation.table}, not ${normalizedTable}`,
    );
  }
  return normalizedTable;
}

function enqueuePersistenceOperation(
  table,
  upserts = [],
  deletes = [],
  ownerFence,
) {
  requireWritableDb();
  const normalizedTable = normalizePersistenceTable(table);
  const normalizedUpserts = validatePersistenceUpserts(upserts);
  const normalizedDeletes = validatePersistenceDeletes(deletes);
  const createdAt = new Date().toISOString();
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);

  const enqueue = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    // Creation and journal insertion share the fenced transaction. A stale
    // owner cannot publish even an empty table before its enqueue is rejected.
    createSqlTable(normalizedTable);
    const result = requireDb()
      .prepare(
        `INSERT INTO _persistence_outbox(
           table_name, owner_role, owner_epoch, owner_instance_id,
           upserts_json, deletes_json, state, created_at, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(
        normalizedTable,
        fence.ownerRole,
        fence.epoch,
        fence.instanceId,
        JSON.stringify(normalizedUpserts),
        JSON.stringify(normalizedDeletes),
        createdAt,
      );
    const operationId = normalizePersistenceOperationId(result.lastInsertRowid);
    return {
      operationId,
      table: normalizedTable,
      ownerRole: fence.ownerRole,
      ownerEpoch: fence.epoch,
      ownerInstanceId: fence.instanceId,
      upserts: normalizedUpserts,
      deletes: normalizedDeletes,
      state: "pending",
      createdAt,
      appliedAt: null,
    };
  });
  const operation = enqueue.immediate();
  ensuredTables.add(normalizedTable);
  return operation;
}

function applyChangeStatements(table, upserts, deletes) {
  const upsert = getUpsertStatement(table);
  const remove = getDeleteStatement(table);
  for (const [key, json] of upserts) {
    upsert.run(String(key), json);
  }
  for (const key of deletes) {
    remove.run(String(key));
  }
  return upserts.length + deletes.length;
}

function applyPersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  const normalizedExpectedTable =
    expectedTable === undefined
      ? undefined
      : normalizePersistenceTable(
        expectedTable,
        "expected persistence table",
      );
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      // A stale worker may begin after synchronous reconciliation removed the
      // row. Treat the already-reconciled operation as a harmless no-op.
      return null;
    }
    if (normalizedExpectedTable !== undefined) {
      assertExpectedPersistenceTable(operation, normalizedExpectedTable);
    }
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
    );
    const appliedAt = operation.appliedAt || new Date().toISOString();
    const updated = requireDb()
      .prepare(
        `UPDATE _persistence_outbox
         SET state = 'applied', applied_at = ?
         WHERE operation_id = ? AND table_name = ?`,
      )
      .run(appliedAt, operation.operationId, operation.table);
    if (updated.changes !== 1) {
      throw new Error(
        `failed to mark persistence operation ${operation.operationId} applied`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt,
    };
  });
  return txn.immediate();
}

function acknowledgePersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      throw new Error(`persistence operation ${normalizedId} does not exist`);
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    if (operation.state !== "applied") {
      throw new Error(
        `persistence operation ${normalizedId} cannot be acknowledged from state ${operation.state}`,
      );
    }
    const removed = requireDb()
      .prepare(
        `DELETE FROM _persistence_outbox
         WHERE operation_id = ? AND table_name = ? AND state = 'applied'`,
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to acknowledge persistence operation ${operation.operationId}`,
      );
    }
    return operation;
  });
  return txn.immediate();
}

function reconcilePersistenceOperation(operationId, expectedTable, ownerFence) {
  requireWritableDb();
  const normalizedId = normalizePersistenceOperationId(operationId);
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operation = getPersistenceOperation(normalizedId, fence);
    if (!operation) {
      return null;
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
    );
    const removed = requireDb()
      .prepare(
        "DELETE FROM _persistence_outbox WHERE operation_id = ? AND table_name = ?",
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to reconcile persistence operation ${operation.operationId}`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt: operation.appliedAt || new Date().toISOString(),
    };
  });
  return txn.immediate();
}

function recoverPersistenceOperations(ownerFence) {
  requireWritableDb();
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  // Read, validate, and replay only this logical owner's journal in one
  // transaction. Applied rows deliberately remain durable until the owner has
  // accepted the recovery callback and acknowledges the exact ordered batch.
  const txn = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const operations = listPersistenceOperations(fence);
    const recovered = [];
    for (const operation of operations) {
      applyChangeStatements(
        operation.table,
        operation.upserts,
        operation.deletes,
      );
      const appliedAt = operation.appliedAt || new Date().toISOString();
      const updated = requireDb()
        .prepare(
          `UPDATE _persistence_outbox
           SET state = 'applied', applied_at = ?
           WHERE operation_id = ? AND table_name = ? AND owner_role = ?`,
        )
        .run(
          appliedAt,
          operation.operationId,
          operation.table,
          fence.ownerRole,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `failed to recover persistence operation ${operation.operationId}`,
        );
      }
      recovered.push({
        ...operation,
        state: "applied",
        appliedAt,
      });
    }
    return recovered;
  });
  return txn.immediate();
}

function acknowledgeRecoveredPersistenceOperations(operationIds, ownerFence) {
  requireWritableDb();
  const ids = [...new Set(
    (Array.isArray(operationIds) ? operationIds : [operationIds])
      .map(normalizePersistenceOperationId),
  )];
  const requestedFence = resolvePersistenceOwnerFence(ownerFence);
  const acknowledge = requireDb().transaction(() => {
    const fence = assertActivePersistenceOwner(requestedFence);
    const acknowledged = [];
    for (const operationId of ids) {
      const operation = getPersistenceOperation(operationId, fence);
      if (!operation) {
        throw persistenceOwnerError(
          `recovered persistence operation ${operationId} does not exist`,
          "PERSISTENCE_OPERATION_NOT_FOUND",
          { operationId },
        );
      }
      if (operation.state !== "applied") {
        throw new Error(
          `recovered persistence operation ${operationId} cannot be acknowledged from state ${operation.state}`,
        );
      }
      acknowledged.push(operation);
    }
    for (const operation of acknowledged) {
      const removed = requireDb()
        .prepare(
          `DELETE FROM _persistence_outbox
           WHERE operation_id = ? AND table_name = ? AND owner_role = ?
             AND state = 'applied'`,
        )
        .run(operation.operationId, operation.table, fence.ownerRole);
      if (removed.changes !== 1) {
        throw new Error(
          `failed to acknowledge recovered persistence operation ${operation.operationId}`,
        );
      }
    }
    return acknowledged;
  });
  return acknowledge.immediate();
}

// Raw `[{ key, json }]` rows as stored — index.js uses these to build both the
// in-memory cache (assembled) and its per-row flush baseline.
function loadRows(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT key, json FROM "${table}"`).all();
}

// Passive readers must not manufacture an empty table or run migration DDL.
// Missing durable schema fails loudly: treating it as an empty baseline makes
// an under-covered read indistinguishable from a legitimately empty table.
function loadExistingRows(table) {
  const normalizedTable = normalizePersistenceTable(table);
  const connection = requireDb();
  const exists = connection
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(normalizedTable);
  if (!exists) {
    const error = new Error(
      `SQLite table does not exist: ${normalizedTable}`,
    );
    error.code = "SQLITE_TABLE_NOT_FOUND";
    error.table = normalizedTable;
    error.dbPath = dbPath;
    throw error;
  }
  return connection
    .prepare(`SELECT key, json FROM "${normalizedTable}"`)
    .all();
}

/**
 * Load an entire table into the nested object index.js caches in memory —
 * assembling wrapper tables back from their per-entity rows.
 */
function loadTableObject(table) {
  const parsed = {};
  for (const row of loadRows(table)) {
    parsed[row.key] = JSON.parse(row.json);
  }
  return assembleFromRows(table, parsed);
}

function loadExistingTableObject(table) {
  const parsed = {};
  for (const row of loadExistingRows(table)) {
    parsed[row.key] = JSON.parse(row.json);
  }
  return assembleFromRows(table, parsed);
}

/**
 * Apply a batch of row changes in a single transaction.
 * @param {Array<[string, string]>} upserts  [key, jsonString] pairs to write.
 * @param {Array<string>} deletes            keys to remove.
 * @returns {number} number of rows touched.
 */
function applyChanges(table, upserts = [], deletes = [], ownerFence) {
  if (upserts.length === 0 && deletes.length === 0) {
    return 0;
  }
  const normalizedTable = normalizePersistenceTable(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const txn = requireWritableDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(normalizedTable);
    return applyChangeStatements(normalizedTable, upserts, deletes);
  });
  const changed = txn.immediate();
  ensuredTables.add(normalizedTable);
  return changed;
}

/**
 * Replace the full contents of a table from a plain object (used by the
 * one-shot JSON → SQLite importer).
 */
function replaceAll(table, object = {}, ownerFence) {
  requireWritableDb();
  const normalizedTable = normalizePersistenceTable(table);
  const requestedFence = resolveDirectMutationFence(ownerFence);
  const rows = explodeToRows(normalizedTable, object);
  const rowKeys = Object.keys(rows);
  const txn = requireDb().transaction(() => {
    assertDirectMutationOwner(requestedFence);
    createSqlTable(normalizedTable);
    const upsert = getUpsertStatement(normalizedTable);
    requireDb().exec(`DELETE FROM "${normalizedTable}"`);
    for (const rowKey of rowKeys) {
      upsert.run(String(rowKey), JSON.stringify(rows[rowKey]));
    }
  });
  txn.immediate();
  ensuredTables.add(normalizedTable);
  return rowKeys.length;
}

function rowCount(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
}

function getDatabasePath() {
  return dbPath;
}

// Pages that deletes and rewrites free stay inside the file until VACUUM, so
// the file never shrinks by itself.
function readPageUsage() {
  const database = requireDb();
  return {
    pageSize: database.pragma("page_size", { simple: true }),
    pageCount: database.pragma("page_count", { simple: true }),
    freePages: database.pragma("freelist_count", { simple: true }),
  };
}

// Below this much free space a mostly-empty file is not worth a message; a
// fresh or small store is often more than half free pages.
const FREE_SPACE_WARNING_MIN_BYTES = 64 * 1024 * 1024;

// The startup message when more than half the file is free pages, else null.
// Compacting is an offline job (tools/Maintenance/vacuum-gamestore.js); the
// server never does it at startup.
function freeSpaceWarning(usage) {
  const pageCount = Number(usage && usage.pageCount) || 0;
  const freePages = Number(usage && usage.freePages) || 0;
  const pageSize = Number(usage && usage.pageSize) || 0;
  const freeBytes = freePages * pageSize;
  if (freePages * 2 <= pageCount || freeBytes < FREE_SPACE_WARNING_MIN_BYTES) {
    return null;
  }
  const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));
  return `gamestore.sqlite is ${Math.round((freePages / pageCount) * 100)}% free pages ` +
    `(${megabytes(freeBytes)} MB of ${megabytes(pageCount * pageSize)} MB). ` +
    'Stop the server and run "node tools/Maintenance/vacuum-gamestore.js" to compact it.';
}

function isReadOnly() {
  return Boolean(db && dbReadOnly);
}

function close() {
  if (db) {
    db.close();
  }
  db = null;
  dbPath = null;
  dbReadOnly = false;
  ensuredTables.clear();
  upsertStatements.clear();
  deleteStatements.clear();
  standalonePersistenceOwnerFence = null;
}

module.exports = {
  init,
  ensureSqlTable,
  isMigrated,
  markMigrated,
  loadRows,
  loadExistingRows,
  loadTableObject,
  loadExistingTableObject,
  explodeToRows,
  assembleFromRows,
  rowValueForKey,
  rowGroupsFor,
  ROW_KEY_SEP,
  LEGACY_PERSISTENCE_OWNER_ROLE,
  STANDALONE_PERSISTENCE_OWNER_ROLE,
  DEFAULT_PERSISTENCE_OWNER_LEASE_MS,
  recoveryRetainsPersistenceOperations: true,
  assertPersistenceOwner,
  withPersistenceOwnerPublicationSync,
  acquirePersistenceOwner,
  renewPersistenceOwner,
  releasePersistenceOwner,
  adoptLegacyPersistenceOperations,
  enqueuePersistenceOperation,
  getPersistenceOperation,
  listPersistenceOperations,
  listAllPersistenceOperations,
  assertNoForeignPersistenceOperations,
  applyPersistenceOperation,
  acknowledgePersistenceOperation,
  acknowledgeRecoveredPersistenceOperations,
  reconcilePersistenceOperation,
  recoverPersistenceOperations,
  applyChanges,
  replaceAll,
  rowCount,
  getDatabasePath,
  readPageUsage,
  freeSpaceWarning,
  FREE_SPACE_WARNING_MIN_BYTES,
  isReadOnly,
  close,
};
