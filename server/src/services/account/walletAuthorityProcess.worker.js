"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "wallet";

const path = require("node:path");

process.env.EVEJS_WALLET_AUTHORITY_OWNER = "1";

const {
  installProcessLifecycleLogging,
} = require(path.join(__dirname, "../../utils/processLifecycle"));

installProcessLifecycleLogging({
  appName: "eve.js wallet authority",
  signals: [],
});

const database = require(path.join(__dirname, "../../gameStore"));
require(path.join(__dirname, "../../gameStore/ownerProcessShutdown"))
  .installOwnerProcessShutdown(database);
const { createOrderedProcessHost } = require(path.join(
  __dirname,
  "../_shared/orderedProcessHost",
));
const { executeWalletCommand } = require(path.join(
  __dirname,
  "./walletCommandAuthority",
));
const receiptState = require(path.join(
  __dirname,
  "./walletAuthorityReceiptState",
));
const ownerState = require(path.join(__dirname, "./walletAuthorityOwnerState"));

// Requiring both facades registers every command handler with the local owner.
require(path.join(__dirname, "./walletState"));
require(path.join(__dirname, "../corporation/corpWalletState"));

function cloneValue(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

// Ledger fields the parent projection mirrors. They are append-only bounded
// lists: writers unshift a freshly normalized entry and slice back to the cap,
// and no writer edits an entry that is already stored. Shipping the whole list
// on every command made each wallet command cost O(history) to clone, serialize
// over IPC and re-clone in the parent, so the projection now carries only the
// entries prepended since the previous publish.
const HISTORY_FIELDS = Object.freeze([
  "walletJournal",
  "marketTransactions",
  "plexVaultTransactions",
]);
// A single command appends at most one entry per list; the small allowance
// keeps the diff bounded while still absorbing a batched write.
const MAX_DELTA_PREPEND = 8;

// characterID -> { [field]: number[] | null } mirroring the entry IDs the parent
// projection currently holds. Only advanced once a publish has actually been
// handed to the IPC channel, so a failed send falls back to a full list.
const publishedCharacterHistory = new Map();

function historyDeltaFieldName(fieldName) {
  return `${fieldName}Delta`;
}

function historyEntryKeys(entries) {
  const keys = [];
  for (const entry of entries) {
    const key = entry && typeof entry === "object"
      ? Number(entry.transactionID)
      : Number.NaN;
    if (!Number.isFinite(key)) {
      // An unkeyed list cannot be diffed safely; ship it whole instead.
      return null;
    }
    keys.push(key);
  }
  return keys;
}

function buildHistoryDelta(previousKeys, keys) {
  if (!Array.isArray(previousKeys) || !Array.isArray(keys)) {
    return null;
  }
  const maxPrepend = Math.min(MAX_DELTA_PREPEND, keys.length);
  for (let prependCount = 0; prependCount <= maxPrepend; prependCount += 1) {
    const keep = keys.length - prependCount;
    if (keep > previousKeys.length) {
      continue;
    }
    let matches = true;
    for (let index = 0; index < keep; index += 1) {
      if (keys[prependCount + index] !== previousKeys[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { prependCount, keep };
    }
  }
  return null;
}

function buildCharacterProjectionEntry(characterID, record) {
  const entry = {
    characterID,
    balance: Number(record.balance || 0),
    aurBalance: Number(record.aurBalance || 0),
    plexBalance: Math.trunc(Number(record.plexBalance) || 0),
    balanceChange: Number(record.balanceChange || 0),
  };
  const tracked = publishedCharacterHistory.get(characterID) || null;
  const nextTracked = {};
  for (const fieldName of HISTORY_FIELDS) {
    const entries = Array.isArray(record[fieldName]) ? record[fieldName] : [];
    const keys = historyEntryKeys(entries);
    const delta = buildHistoryDelta(tracked && tracked[fieldName], keys);
    if (delta) {
      entry[historyDeltaFieldName(fieldName)] = {
        prepend: cloneValue(entries.slice(0, delta.prependCount)),
        keep: delta.keep,
      };
    } else {
      entry[fieldName] = cloneValue(entries);
    }
    nextTracked[fieldName] = keys;
  }
  return { entry, characterID, nextTracked };
}

function commitPublishedHistory(pendingHistory) {
  for (const pending of pendingHistory) {
    publishedCharacterHistory.set(pending.characterID, pending.nextTracked);
  }
}

function touchedOwnerIDs(commandType, payload = {}) {
  if (commandType === "character.transfer-isk") {
    return {
      characterIDs: [payload.fromCharId, payload.toCharId],
      corporationIDs: [],
    };
  }
  if (commandType === "corporation.transfer-isk") {
    return {
      characterIDs: [],
      corporationIDs: [
        payload.fromCorporationID,
        payload.toCorporationID,
      ],
    };
  }
  if (commandType === "corporation.liquidate-to-character") {
    return {
      characterIDs: [payload.toCharacterID],
      corporationIDs: [payload.fromCorporationID],
    };
  }
  if (commandType === "corporation.distribute-isk") {
    const allocations = Array.isArray(payload.allocations)
      ? payload.allocations
      : [];
    return {
      characterIDs: allocations
        .filter((allocation) => allocation && allocation.kind === "character")
        .map((allocation) => allocation.ownerID),
      corporationIDs: [
        payload.sourceCorporationID,
        ...allocations
          .filter((allocation) =>
            allocation && allocation.kind === "corporation")
          .map((allocation) => allocation.ownerID),
      ],
    };
  }
  if (String(commandType).startsWith("character.")) {
    return { characterIDs: [payload.charId], corporationIDs: [] };
  }
  if (String(commandType).startsWith("corporation.")) {
    return { characterIDs: [], corporationIDs: [payload.corporationID] };
  }
  return { characterIDs: [], corporationIDs: [] };
}

function buildProjection(commandType, payload) {
  const touched = touchedOwnerIDs(commandType, payload);
  const pendingHistory = [...new Set(
    touched.characterIDs.map(Number).filter((id) => id > 0),
  )]
    .map((characterID) => ({
      characterID,
      record: ownerState.getCharacterRecord(characterID),
    }))
    .filter((entry) => entry.record)
    .map(({ characterID, record }) =>
      buildCharacterProjectionEntry(characterID, record));
  const corporations = [...new Set(
    touched.corporationIDs.map(Number).filter((id) => id > 0),
  )]
    .map((corporationID) => ({
      corporationID,
      runtime: ownerState.getCorporationRuntime(corporationID),
    }))
    .filter((entry) => entry.runtime)
    .map((entry) => ({
      corporationID: entry.corporationID,
      wallet: cloneValue(entry.runtime.wallet || null),
    }));
  return {
    characters: pendingHistory.map((pending) => pending.entry),
    corporations,
    pendingHistory,
  };
}

function buildStartupProjection() {
  const pendingHistory = [];
  const corporations = [];
  for (const record of ownerState.listOwnedRecords()) {
    const characterID = Math.trunc(Number(record && record.characterID) || 0);
    if (characterID > 0) {
      pendingHistory.push(buildCharacterProjectionEntry(characterID, record));
      continue;
    }
    const corporationID = Math.trunc(Number(record && record.corporationID) || 0);
    if (corporationID > 0) {
      corporations.push({
        corporationID,
        wallet: cloneValue(record.wallet || null),
      });
    }
  }
  return {
    characters: pendingHistory.map((pending) => pending.entry),
    corporations,
    pendingHistory,
  };
}

// Carry the authority's replay verdict across the IPC boundary.
//
// executeIdempotently answers a commandID it has already seen with the result
// that commandID committed, and does not re-execute. Read its comment before
// changing anything here: throwing wedges a legitimate replay forever, and
// executing pays twice. It also says the cached amount is the wrong one when
// the hit was a genuine commandID collision, and that callers needing more than
// its WARN must cross-check the amount they got against what they meant to move.
//
// They could not. Both `duplicate` and `fingerprintMismatch` died in this
// function -- only `outcome.result` was returned -- so every caller saw an
// ordinary success carrying another operation's numbers. Two defects followed:
//
//   - No money moved, but a settlement read the success as "the debit
//     committed" and completed the job without charging anyone.
//   - walletState read `result.data.balance` as the *current* balance and
//     pushed it to the client as an OnAccountChange. On a collision that is a
//     wholly unrelated operation's balance, which the player sees as an
//     enormous phantom debit corrected only by relogging. On an ordinary
//     replay it is this operation's own balance as of its original commit,
//     which is equally wrong the moment anything credited the wallet in
//     between -- a durable retry then walks the displayed balance backwards
//     over a credit the client had already been told about.
//
// The second of those, and the shape of this function, come from a fix posted
// to the community Discord for the same 0.12.8 report; the vendor guard it
// makes live (`result.duplicate !== true`) was already on the character path
// and merely had nothing to act on.
//
// The flags ride on the result rather than replacing it, so the deliberately
// tolerant behaviour above is untouched for a caller that does not look.
function tagReplayVerdict(outcome) {
  const result = outcome && outcome.result;
  if (
    outcome.duplicate !== true ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result;
  }
  return {
    ...result,
    duplicate: true,
    fingerprintMismatch: outcome.fingerprintMismatch === true,
  };
}

createOrderedProcessHost({
  authorityName: "wallet",
  onStart({ publish }) {
    const startup = buildStartupProjection();
    const published = publish("wallet.snapshot", {
      characters: startup.characters,
      corporations: startup.corporations,
    });
    if (published) {
      commitPublishedHistory(startup.pendingHistory);
    }
  },
  handleCommand(commandType, payload, context) {
    const outcome = receiptState.executeIdempotently(
      commandType,
      payload,
      context.metadata,
      executeWalletCommand,
    );
    if (
      outcome.duplicate !== true &&
      context.metadata.testCrashAfterCommit === true &&
      process.env.NODE_TEST_CONTEXT
    ) {
      process.exit(86);
      return new Promise(() => {});
    }
    const projection = buildProjection(commandType, payload);
    const published = context.publish("wallet.committed", {
      commandID: context.metadata.commandID,
      commandType,
      duplicate: outcome.duplicate,
      characters: projection.characters,
      corporations: projection.corporations,
    });
    if (published) {
      commitPublishedHistory(projection.pendingHistory);
    }
    return tagReplayVerdict(outcome);
  },
  onShutdown() {
    return database.shutdown("wallet-host");
  },
});
