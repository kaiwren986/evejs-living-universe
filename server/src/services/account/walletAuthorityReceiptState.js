"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));
const ownerState = require(path.join(__dirname, "./walletAuthorityOwnerState"));

const MAX_RECEIPTS = 1024;

// A receipt is stored inside the very record the command just wrote, so a
// command result that carries the owner record back would nest the receipt list
// inside itself and double the stored record on every command. That is exactly
// what happened: character.append-market-transaction returned the owner-state
// write result (whose `data` is the whole record), and one character's owner
// record grew 62 KB -> 126 KB -> ... -> 262 MB across twelve market fills, until
// a single wallet command could no longer finish inside the transport's 15 s
// deadline and every wallet call timed out.
//
// The handler no longer returns the record, but the invariant is enforced here
// too: a persisted receipt result never contains a receipt list. Nothing replays
// those lists -- duplicate detection only needs commandID and fingerprint -- and
// the sanitizer also heals records written before this guard existed, because
// appendReceipt rewrites the whole array on every commit.
const RECEIPT_LIST_FIELDS = new Set([
  "walletAuthorityReceipts",
  "walletOperationReceipts",
  "nodeGraphWalletReceipts",
  "freelanceWalletReceipts",
  "contractWalletReceipts",
  "campaignWalletReceipts",
  "nodeGraphRewardReceipts",
  "adjustmentReceipts",
]);
const MAX_RECEIPT_RESULT_DEPTH = 16;

function sanitizeReceiptResult(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (depth >= MAX_RECEIPT_RESULT_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReceiptResult(item, depth + 1));
  }
  const sanitized = {};
  for (const key of Object.keys(value)) {
    if (RECEIPT_LIST_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeReceiptResult(value[key], depth + 1);
  }
  return sanitized;
}

function sanitizeStoredReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    return receipt;
  }
  return {
    ...receipt,
    result: sanitizeReceiptResult(receipt.result),
  };
}

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return String(value);
}

function fingerprint(commandType, payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize({ commandType, payload })), "utf8")
    .digest("base64url");
}

function resolveReceiptTarget(commandType, payload = {}) {
  if (String(commandType).startsWith("character.")) {
    const characterID = Math.trunc(Number(
      payload.charId || payload.fromCharId || 0,
    ) || 0);
    return characterID > 0
      ? { kind: "character", ownerID: characterID }
      : null;
  }
  if (
    commandType === "corporation.transfer-isk" ||
    commandType === "corporation.liquidate-to-character" ||
    commandType === "corporation.distribute-isk"
  ) {
    const corporationID = Math.trunc(Number(
      payload.fromCorporationID || payload.sourceCorporationID,
    ) || 0);
    return corporationID > 0
      ? { kind: "corporation", ownerID: corporationID }
      : null;
  }
  if (String(commandType).startsWith("corporation.")) {
    const corporationID = Math.trunc(Number(payload.corporationID) || 0);
    return corporationID > 0
      ? { kind: "corporation", ownerID: corporationID }
      : null;
  }
  return null;
}

function getReceipts(target) {
  if (!target) {
    return [];
  }
  if (target.kind === "character") {
    const record = ownerState.getCharacterRecord(target.ownerID);
    return Array.isArray(record && record.walletAuthorityReceipts)
      ? record.walletAuthorityReceipts
      : [];
  }
  const runtime = ownerState.getCorporationRuntime(target.ownerID);
  return Array.isArray(runtime && runtime.wallet && runtime.wallet.authorityReceipts)
    ? runtime.wallet.authorityReceipts
    : [];
}

function targetExists(target) {
  if (!target) {
    return false;
  }
  return target.kind === "character"
    ? Boolean(ownerState.getCharacterRecord(target.ownerID))
    : Boolean(ownerState.getCorporationRuntime(target.ownerID));
}

function appendReceipt(target, receipt) {
  if (target.kind === "character") {
    return ownerState.updateCharacterRecord(target.ownerID, (record) => {
      const receipts = Array.isArray(record.walletAuthorityReceipts)
        ? record.walletAuthorityReceipts
            .filter(
              (candidate) => candidate && candidate.commandID !== receipt.commandID,
            )
            .map(sanitizeStoredReceipt)
        : [];
      receipts.unshift(sanitizeStoredReceipt(receipt));
      record.walletAuthorityReceipts = receipts.slice(0, MAX_RECEIPTS);
      return record;
    });
  }

  return ownerState.updateCorporationRuntime(target.ownerID, (runtime) => {
    runtime.wallet = runtime.wallet && typeof runtime.wallet === "object"
      ? runtime.wallet
      : { divisions: {} };
    const receipts = Array.isArray(runtime.wallet.authorityReceipts)
      ? runtime.wallet.authorityReceipts
          .filter(
            (candidate) => candidate && candidate.commandID !== receipt.commandID,
          )
          .map(sanitizeStoredReceipt)
      : [];
    receipts.unshift(sanitizeStoredReceipt(receipt));
    runtime.wallet.authorityReceipts = receipts.slice(0, MAX_RECEIPTS);
    return runtime;
  });
}

function executeIdempotently(commandType, payload, metadata, execute) {
  const commandID = String(metadata && metadata.commandID || "").trim();
  if (!commandID || commandID.length > 320) {
    const error = new Error("Wallet authority command ID is invalid");
    error.code = "WALLET_AUTHORITY_COMMAND_ID_INVALID";
    throw error;
  }
  const target = resolveReceiptTarget(commandType, payload);
  const canPersistReceipt = targetExists(target);
  const commandFingerprint = fingerprint(commandType, payload);
  const existing = (canPersistReceipt ? getReceipts(target) : []).find(
    (receipt) => receipt && receipt.commandID === commandID,
  );
  if (existing) {
    if (existing.fingerprint !== commandFingerprint) {
      // MONEY PATH -- read the reasoning before changing this back to a throw.
      //
      // A commandID hit whose fingerprint differs has exactly two causes:
      //
      //   (a) the same operation is replaying, but the payload it builds today
      //       is shaped differently than the one that committed. Every schema
      //       change on a payout path does this. The mission reward split of
      //       reward/time-bonus into separate journal ref types (entryTypeID
      //       33/34) plus corporation tax changed the payload of an in-flight
      //       settlement, so its replay no longer matched its own receipt.
      //   (b) two genuinely different operations picked the same commandID.
      //
      // Throwing cannot tell them apart, and it is the wrong answer for both.
      // For (a) it converts a harmless idempotent replay into a permanent
      // wedge: the durable job retries forever, the pending settlement record
      // blocks every later operation for that owner, and -- because the throw
      // escapes the saga's result-shaped error handling -- it does so without
      // a single log line. One such settlement failed 297 times over 20 hours
      // in silence. For (b) throwing does not protect anything either: the
      // command is refused either way, so no money moves; the only difference
      // is whether the caller can make progress afterwards.
      //
      // Executing is never on the table here -- a commandID with a receipt has
      // already moved money exactly once, and that is the invariant the receipt
      // exists to defend. So the choice is only "return what committed" vs
      // "wedge". Returning the cached result keeps the ledger correct and lets
      // the saga finish; the WARN below is how (b) becomes visible.
      //
      // (b) is bounded by construction: commandIDs are namespaced
      // <domain>:<ownerID>:<sequence>:<leg>, so a collision needs a per-owner
      // sequence counter to repeat -- a store-integrity fault with its own
      // guard (mission sequences are advanced past every sequence any receipt
      // references, see missionRewardSettlementRecovery). Callers that need
      // more than the log -- the startup heal pass does -- cross-check the
      // returned result's amount against what they expected to pay rather than
      // treating "a receipt exists" as proof on its own.
      log.warn(
        `[WalletAuthority] commandID=${commandID} type=${commandType} replayed ` +
          `with a different payload fingerprint; returning the committed result ` +
          `instead of re-executing. Expected when a payout schema changed under ` +
          `an in-flight operation; if this owner's operation sequence can repeat, ` +
          `it is a commandID collision and the cached amount is the wrong one.`,
      );
      return {
        duplicate: true,
        fingerprintMismatch: true,
        result: cloneValue(existing.result),
        target,
      };
    }
    return {
      duplicate: true,
      result: cloneValue(existing.result),
      target,
    };
  }

  const result = execute(commandType, payload, {
    source: "wallet-authority-process",
    idempotencyKey: commandID,
  });
  if (!canPersistReceipt) {
    return { duplicate: false, result, target: null };
  }
  const writeResult = appendReceipt(target, {
    commandID,
    commandType,
    fingerprint: commandFingerprint,
    committedAt: new Date().toISOString(),
    // sanitizeStoredReceipt deep-copies what it keeps, so appendReceipt still
    // stores a detached value without cloning the live result up front.
    result,
  });
  if (!writeResult || writeResult.success !== true) {
    const error = new Error(
      writeResult && writeResult.errorMsg || "Wallet authority receipt write failed",
    );
    error.code = "WALLET_AUTHORITY_RECEIPT_WRITE_FAILED";
    throw error;
  }
  const flushResult = ownerState.flushSync();
  if (!flushResult || flushResult.success !== true) {
    const error = new Error(
      flushResult && flushResult.errorMsg || "Wallet authority commit flush failed",
    );
    error.code = "WALLET_AUTHORITY_COMMIT_AMBIGUOUS";
    throw error;
  }
  return { duplicate: false, result, target };
}

/**
 * Whether an owner's authority-receipt list has reached the eviction cap.
 *
 * appendReceipt slices the list to MAX_RECEIPTS on every commit, so a list AT
 * the cap is the durable signal that the oldest receipts have been (or are
 * about to be) evicted. That distinction is what a recovery pass needs before it
 * reads "no receipt" as "never applied": below the cap no append has ever had to
 * drop a receipt, so an absent commandID was genuinely never written; at the cap
 * an absent commandID may have committed and then been evicted, and replaying it
 * could pay a second time. Returns false for an owner with no record -- there
 * are no receipts and no eviction, so absence there is honest.
 */
function isOwnerReceiptListSaturated(target) {
  const normalizedTarget = target && {
    kind: target.kind === "corporation" ? "corporation" : "character",
    ownerID: Math.trunc(Number(target.ownerID) || 0),
  };
  if (
    !normalizedTarget ||
    normalizedTarget.ownerID <= 0 ||
    !targetExists(normalizedTarget)
  ) {
    return false;
  }
  return getReceipts(normalizedTarget).length >= MAX_RECEIPTS;
}

/**
 * Read-only lookup of the receipt a commandID committed, for recovery passes
 * that must decide whether a leg already moved money. `target` is
 * `{kind: "character"|"corporation", ownerID}` -- the same shape
 * resolveReceiptTarget produces.
 *
 * The fingerprint is deliberately NOT compared: a caller asking this question
 * is asking "did this command commit", and the whole point is that a stale
 * payload shape must not hide a commit that happened. Callers verify the
 * *amount* on the returned result instead (see executeIdempotently's comment).
 */
function findOwnerReceipt(target, commandID) {
  const normalizedCommandID = String(commandID || "").trim();
  if (!normalizedCommandID || !target) {
    return null;
  }
  const normalizedTarget = {
    kind: target.kind === "corporation" ? "corporation" : "character",
    ownerID: Math.trunc(Number(target.ownerID) || 0),
  };
  if (normalizedTarget.ownerID <= 0 || !targetExists(normalizedTarget)) {
    return null;
  }
  const receipt = getReceipts(normalizedTarget).find(
    (candidate) => candidate && candidate.commandID === normalizedCommandID,
  );
  return receipt ? cloneValue(receipt) : null;
}

module.exports = {
  MAX_RECEIPTS,
  executeIdempotently,
  findOwnerReceipt,
  fingerprint,
  isOwnerReceiptListSaturated,
};
