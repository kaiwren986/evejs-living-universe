"use strict";

/**
 * Shared recovery helpers for the escrow settlement sagas.
 *
 * Every saga (reprocessing, mission rewards, industry installs, planetary
 * customs) runs the same shape: move goods into a per-operation escrow
 * location, then out again, checkpointing each leg into its own durable
 * record. Custody commands are idempotent, so a replayed leg is safe — but a
 * replay only helps if the saga can still tell *which row* the original leg
 * produced, and if a lost checkpoint can be recovered from the ledger rather
 * than retried against escrow that has already been emptied.
 *
 * Without that, an interrupted saga wedges: it can neither finish nor fail, it
 * retries forever, and the per-character pending record blocks the feature for
 * that character permanently.
 */

const path = require("node:path");

const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const log = require(path.join(__dirname, "../../utils/logger"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Resolves the item a custody command acted on, across all three shapes a
 * result can take: a live mutation, a replay that names its rows, and a replay
 * whose rows are only recorded on the receipt.
 */
function resolveCustodyResultItem(result) {
  const data = result && result.data;
  if (!data) {
    return null;
  }
  if (data.item && typeof data.item === "object") {
    return data.item;
  }
  const items = Array.isArray(data.items) ? data.items.filter(Boolean) : [];
  if (items.length > 0) {
    return items[0];
  }
  const changed = (Array.isArray(data.changes) ? data.changes : [])
    .map((change) => change && change.item)
    .find(Boolean);
  if (changed) {
    return changed;
  }
  const receiptItemIDs = [
    ...(Array.isArray(data.itemIDs) ? data.itemIDs : []),
    ...(result.receipt && result.receipt.resultData &&
      Array.isArray(result.receipt.resultData.itemIDs)
      ? result.receipt.resultData.itemIDs
      : []),
    ...(data.receipt && data.receipt.resultData &&
      Array.isArray(data.receipt.resultData.itemIDs)
      ? data.receipt.resultData.itemIDs
      : []),
  ].map((value) => toPositiveInt(value, 0)).filter(Boolean);
  return receiptItemIDs.length > 0 ? { itemID: receiptItemIDs[0] } : null;
}

/**
 * True when the custody command behind `idempotencyKey` has already committed
 * durably — i.e. this leg's work is done even if its checkpoint was lost.
 */
function custodyStepCommitted(idempotencyKey) {
  const receipt = itemCustody.getCommittedReceipt(idempotencyKey);
  return Boolean(receipt && receipt.committed);
}

/**
 * The client-facing changes a committed custody step recorded, so a recovered
 * leg can still notify the inventory rows it moved.
 */
function custodyStepChanges(idempotencyKey) {
  const receipt = itemCustody.getCommittedReceipt(idempotencyKey);
  const changes = receipt && receipt.resultData && receipt.resultData.changes;
  return Array.isArray(changes) ? changes : [];
}

/**
 * A settlement leg that cannot be resolved is the shape that used to retry
 * silently forever. Every one of them is now audible, with the operation and
 * step named so the wedged saga is findable in the log.
 */
function reportUnresolvedLeg(context = {}) {
  const scope = String(context.scope || "Settlement");
  log.warn(
    `[${scope}] Unresolved escrow leg operation=` +
      `${String(context.operationID || "unknown")} step=` +
      `${String(context.step || "unknown")} leg=` +
      `${String(context.legID || "unknown")}: ` +
      `${String(context.errorMsg || "UNKNOWN")}; settlement remains pending`,
  );
}

/**
 * Escalates a settlement that keeps failing. The durable scheduler retries
 * with backoff and never gives up, so without this a permanently unresolvable
 * saga produces no signal at all.
 */
function reportSettlementRetry(context = {}) {
  const scope = String(context.scope || "Settlement");
  const attempt = Math.max(0, Math.trunc(Number(context.attempt) || 0));
  const message =
    `[${scope}] Settlement retry attempt=${attempt} owner=` +
    `${String(context.ownerID || "unknown")}: ${String(context.errorMsg || "UNKNOWN")}`;
  if (attempt >= 10) {
    log.error(
      `${message}; the pending record is blocking new requests and needs ` +
        `operator review`,
    );
    return;
  }
  if (attempt >= 3) {
    log.warn(message);
  }
}

module.exports = {
  custodyStepChanges,
  custodyStepCommitted,
  reportSettlementRetry,
  reportUnresolvedLeg,
  resolveCustodyResultItem,
};
