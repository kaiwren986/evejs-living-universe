"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const persistenceRoles = require(path.join(
  __dirname,
  "../../gameStore/persistenceRoles",
));

const TABLE_NAME = "walletAuthorityState";

// Only the wallet authority process may mutate walletAuthorityState. Every
// other role still has to be able to READ it: the mission reward startup heal
// runs in `world` and decides whether a payout leg already committed purely
// from this table's receipt ledger.
//
// The cached read path cannot serve them. read() -> ensureCached() would pull
// another owner's table into this process's cache (and hand it to the flusher),
// so readOwnedRecord/listOwnedRecords call ensureTable() first -- and ensureTable
// is classified as a mutation. In `world` that threw
// GAMESTORE_PROCESS_OWNERSHIP_VIOLATION and took the whole heal down with it.
//
// readPersisted is the store's cross-process read primitive: it reads durable
// SQLite directly, never populates the cache, and carries no write authority.
// Correct here because the heal runs before anything is queued and before any
// player can connect, and because the wallet process flushes each receipt
// synchronously (see walletAuthorityReceiptState.executeIdempotently) before its
// command returns -- so a receipt that exists is a receipt this read can see.
const OWNS_TABLE = persistenceRoles.roleMayMutateTable(
  database._processRole,
  TABLE_NAME,
);
const CHARACTER_FIELDS = Object.freeze([
  "balance",
  "aurBalance",
  "plexBalance",
  "balanceChange",
  "walletJournal",
  "marketTransactions",
  "plexVaultTransactions",
  "walletOperationReceipts",
  "nodeGraphWalletReceipts",
  "freelanceWalletReceipts",
  "contractWalletReceipts",
  "campaignWalletReceipts",
  "walletAuthorityReceipts",
]);

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function normalizeOwnerID(value) {
  const ownerID = Math.trunc(Number(value) || 0);
  return ownerID > 0 ? ownerID : 0;
}

function characterKey(characterID) {
  return `character:${normalizeOwnerID(characterID)}`;
}

function corporationKey(corporationID) {
  return `corporation:${normalizeOwnerID(corporationID)}`;
}

/**
 * Read one path out of walletAuthorityState under whichever role this process
 * holds. The owner reads its live cache; everyone else reads durable SQLite.
 *
 * "Absent" is reported the same way by both paths (null), which is the safe
 * direction for every caller here: a missing receipt makes the heal replay the
 * leg, and replays are keyed by commandID so the authority returns the
 * committed result instead of paying twice. A read that *fails* is different --
 * it is indistinguishable from "absent" to the caller, so it is logged.
 */
function readOwnedPath(pth) {
  if (OWNS_TABLE) {
    database.ensureTable(TABLE_NAME);
    return database.read(TABLE_NAME, pth);
  }
  const result = database.readPersisted(TABLE_NAME, pth);
  if (
    result && result.success !== true &&
    result.errorMsg !== "ENTRY_NOT_FOUND" &&
    result.errorMsg !== "SQLITE_TABLE_NOT_FOUND"
  ) {
    log.warn(
      `[WalletAuthorityOwnerState] durable read of ${TABLE_NAME}${pth} failed ` +
        `under role ${database._processRole}: ${result.errorMsg || "UNKNOWN"}. ` +
        `Callers will see this as "no record", which makes recovery replay ` +
        `legs that may already have committed receipts`,
    );
  }
  return result;
}

function readOwnedRecord(key) {
  const result = readOwnedPath(`/${key}`);
  return result && result.success ? cloneValue(result.data) : null;
}

function listOwnedRecords() {
  const result = readOwnedPath("/");
  const table = result && result.success && result.data &&
    typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data
    : {};
  return Object.values(table).map((record) => cloneValue(record));
}

function writeOwnedRecord(key, record) {
  database.ensureTable(TABLE_NAME);
  const detached = cloneValue(record);
  const result = database.write(TABLE_NAME, `/${key}`, detached);
  return result && result.success
    ? { success: true, data: detached }
    : { success: false, errorMsg: result && result.errorMsg || "WRITE_ERROR" };
}

function seedCharacterRecord(characterID) {
  const durable = database.readPersisted(
    "characters",
    `/${normalizeOwnerID(characterID)}`,
  );
  const base = durable && durable.success ? durable.data : null;
  if (!base || typeof base !== "object") {
    return null;
  }
  const record = { characterID: normalizeOwnerID(characterID) };
  for (const field of CHARACTER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(base, field)) {
      record[field] = cloneValue(base[field]);
    }
  }
  const result = writeOwnedRecord(characterKey(characterID), record);
  return result.success ? result.data : null;
}

function getCharacterRecord(characterID) {
  const ownerID = normalizeOwnerID(characterID);
  if (!ownerID) {
    return null;
  }
  const existing = readOwnedRecord(characterKey(ownerID));
  // Seeding writes. Only the owner may do it; a reader that finds nothing has
  // its answer -- no owner record means no receipts.
  return existing || (OWNS_TABLE ? seedCharacterRecord(ownerID) : null);
}

function updateCharacterRecord(characterID, updater) {
  const current = getCharacterRecord(characterID);
  if (!current) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current))
    : updater;
  return writeOwnedRecord(characterKey(characterID), {
    ...cloneValue(next || current),
    characterID: normalizeOwnerID(characterID),
  });
}

function seedCorporationRuntime(corporationID) {
  const durable = database.readPersisted(
    "corporationRuntime",
    `/corporations/${normalizeOwnerID(corporationID)}`,
  );
  const base = durable && durable.success ? durable.data : null;
  if (!base || typeof base !== "object") {
    return null;
  }
  const record = {
    corporationID: normalizeOwnerID(corporationID),
    wallet: cloneValue(base.wallet || { divisions: {} }),
  };
  const result = writeOwnedRecord(corporationKey(corporationID), record);
  return result.success ? result.data : null;
}

function getCorporationRuntime(corporationID) {
  const ownerID = normalizeOwnerID(corporationID);
  if (!ownerID) {
    return null;
  }
  const existing = readOwnedRecord(corporationKey(ownerID));
  return existing || (OWNS_TABLE ? seedCorporationRuntime(ownerID) : null);
}

function updateCorporationRuntime(corporationID, updater) {
  const current = getCorporationRuntime(corporationID);
  if (!current) {
    return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
  }
  const next = typeof updater === "function"
    ? updater(cloneValue(current)) || current
    : current;
  return writeOwnedRecord(corporationKey(corporationID), {
    ...cloneValue(next),
    corporationID: normalizeOwnerID(corporationID),
  });
}

function flushSync() {
  return database.flushTableSync(TABLE_NAME);
}

module.exports = {
  TABLE_NAME,
  flushSync,
  getCharacterRecord,
  getCorporationRuntime,
  listOwnedRecords,
  updateCharacterRecord,
  updateCorporationRuntime,
};
