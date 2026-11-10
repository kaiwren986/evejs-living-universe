"use strict";

// Container outcomes belong to the existing dungeon instance. Board turns stay
// transient; this owner retains only the failure count and terminal receipts.
// Keep imports lazy so native slim builders can use the pure state accessors.
const SECURE = 0;
const BEING_HACKED = 1;
const HACKED = 2;
const LOCKED = 3;
const DEPOT_TYPES = new Set([92144, 92145]);

function int(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isHackable(entity) {
  return Boolean(entity && entity.dungeonMaterializedSiteContent === true &&
    entity.dungeonMaterializedContainer === true &&
    ["data", "relic"].includes(String(entity.dungeonSiteContentAnalyzer || "").trim().toLowerCase()));
}

function getState(entity) {
  const value = entity && (entity.hackingSecurityState ?? entity.dungeonSiteContentHackingState);
  const state = int(value, SECURE);
  return state === BEING_HACKED || state === HACKED || state === LOCKED ? state : SECURE;
}

function getFailurePolicy(entity) {
  return {
    locksOut: entity?.dungeonSiteContentFailureLocksOut === true,
    neverDestroys: entity?.dungeonSiteContentFailureNeverDestroys === true,
    explodes: entity?.dungeonSiteContentFailureExplodes === true,
    maxFailures: 2,
  };
}

function canAttempt(entity) {
  return isHackable(entity) && getState(entity) === SECURE && !isDestroyed(entity);
}

function setTransientState(entity, state, options = {}) {
  if (!entity) return SECURE;
  const normalized = state === BEING_HACKED || state === HACKED || state === LOCKED ? state : SECURE;
  entity.hackingSecurityState = normalized;
  entity.dungeonSiteContentHackingState = normalized;
  const nowMs = Math.max(1, int(options.nowMs, Date.now()));
  if (normalized === BEING_HACKED) entity.dungeonSiteContentHackingStartedAtMs = nowMs;
  else delete entity.dungeonSiteContentHackingStartedAtMs;
  if (normalized === HACKED) entity.dungeonSiteContentHackedAtMs = nowMs;
  return normalized;
}

function identity(entity) {
  const instanceID = Math.max(0, int(entity && entity.dungeonSiteInstanceID));
  const contentKey = String(entity && entity.dungeonSiteContentKey || "").trim();
  const sourceObjectID = Math.max(0, int(entity && (entity.dungeonSourceObjectID || entity.dunObjectID)));
  const key = contentKey || (sourceObjectID > 0 ? `object:${sourceObjectID}` : "");
  return { instanceID, key, contentKey, sourceObjectID };
}

function owns(entity) {
  return isHackable(entity) && !entity.homefrontKey && !DEPOT_TYPES.has(int(entity.typeID));
}

function isDestroyed(entity) {
  return entity?.dungeonSiteContentDestroyedByHack === true;
}

function getRecord(entity, options = {}) {
  const id = identity(entity);
  if (!owns(entity) || !id.instanceID || !id.key) return null;
  const instance = options.instance || require("../dungeon/dungeonRuntime").getInstance(id.instanceID);
  if (!instance || int(instance.instanceID) !== id.instanceID) return null;
  const record = object(instance.spawnState).hackingContainers?.[id.key];
  return record && typeof record === "object" ? JSON.parse(JSON.stringify(record)) : null;
}

function restore(entity, options = {}) {
  if (!isHackable(entity)) return { owned: false, state: getState(entity) };
  if (!owns(entity)) return { owned: false, state: getState(entity) };
  const record = getRecord(entity, options);
  // An unfinished attempt is never resumed by simply reloading its container.
  const state = record?.state === HACKED ? HACKED : record?.state === LOCKED ? LOCKED : SECURE;
  setTransientState(entity, state, { nowMs: record?.hackedAtMs || options.nowMs });
  entity.dungeonSiteContentFailureCount = Math.max(0, int(record?.failureCount));
  entity.dungeonSiteContentDestroyedByHack = record?.destroyed === true;
  return { owned: true, state, failureCount: entity.dungeonSiteContentFailureCount,
    destroyed: record?.destroyed === true, record };
}

function writeRecord(entity, record, options = {}) {
  const runtime = require("../dungeon/dungeonRuntime");
  const id = identity(entity);
  const instance = runtime.getInstance(id.instanceID);
  if (!instance || !id.key) return { success: false, errorMsg: "HACKING_CONTAINER_IDENTITY_REQUIRED" };
  try {
    // Force a durable write even on duplicate receipts: a prior failed flush
    // must never turn an in-memory result into authorization to publish a win.
    runtime.mergeSpawnState(id.instanceID, {
      hackingContainers: { ...object(instance.spawnState?.hackingContainers), [id.key]: record },
    }, { nowMs: options.nowMs, durable: true, force: true });
  } catch (error) {
    return { success: false, errorMsg: "HACKING_CONTAINER_COMMIT_FAILED", cause: error?.message };
  }
  return { success: true, durable: true };
}

/**
 * Settle one server-owned attempt before publishing its outcome. The caller
 * retains outcomeID across retries. Loss counts increase once per receipt.
 * Depot retains its dedicated seasonal outcome owner.
 */
function commitOutcome(entity, options = {}) {
  if (!owns(entity)) return { success: true, owned: false, state: getState(entity) };
  const id = identity(entity);
  const outcomeID = String(options.outcomeID || "").trim();
  const outcome = options.outcome;
  if (!id.instanceID || !id.key) return { success: false, errorMsg: "HACKING_CONTAINER_IDENTITY_REQUIRED" };
  if (!outcomeID || outcomeID.length > 128 || !["won", "lost"].includes(outcome)) {
    return { success: false, errorMsg: "HACKING_CONTAINER_OUTCOME_INVALID" };
  }
  if (options.careerWin && (outcome !== "won" ||
      !require("../career/careerHackingEvidence").isPreparedWin(options.careerWin))) {
    return { success: false, errorMsg: "HACKING_CONTAINER_CAREER_WIN_INVALID" };
  }
  const previous = getRecord(entity) || {};
  const receipts = object(previous.outcomes);
  const existing = Object.hasOwn(receipts, outcomeID) ? receipts[outcomeID] : null;
  if (existing && existing.outcome !== outcome) return { success: false, errorMsg: "HACKING_CONTAINER_OUTCOME_CONFLICT" };
  if (!existing && (previous.destroyed === true || previous.state === HACKED || previous.state === LOCKED)) {
    return { success: false, errorMsg: "HACKING_CONTAINER_ALREADY_RESOLVED" };
  }
  const nowMs = Math.max(1, int(options.nowMs, Date.now()));
  const failureCount = existing ? Math.max(0, int(previous.failureCount))
    : Math.max(0, int(previous.failureCount)) + (outcome === "lost" ? 1 : 0);
  const policy = getFailurePolicy(entity);
  const locked = previous.state === LOCKED || (!existing && outcome === "lost" && policy.locksOut);
  const destroyed = previous.destroyed === true || (!existing && outcome === "lost" &&
    !locked && !policy.neverDestroys &&
    (options.destroyed === true || policy.explodes || failureCount >= policy.maxFailures));
  const receipt = existing || {
    outcomeID, outcome, atMs: nowMs, nowMs,
    characterID: Math.max(0, int(options.characterID)) || null,
    moduleItemID: Math.max(0, int(options.moduleItemID)) || null,
    successEffectsDelivered: false,
    failureEffectsDelivered: false,
    ...(options.careerWin ? { careerWin: structuredClone(options.careerWin) } : {}),
  };
  const record = {
    ...previous, version: 1, contentKey: id.contentKey || null,
    sourceObjectID: id.sourceObjectID || null,
    state: existing ? previous.state : outcome === "won" ? HACKED : locked ? LOCKED : SECURE,
    failureCount, destroyed,
    ...(outcome === "won" ? { hackedAtMs: previous.hackedAtMs || nowMs } : {}),
    ...(destroyed || locked ? { resolvedAtMs: previous.resolvedAtMs || nowMs } : {}),
    outcomes: { ...receipts, [outcomeID]: receipt },
  };
  const result = writeRecord(entity, record, { nowMs });
  if (!result.success) return result;
  // Native/legacy state only becomes visible after the durable barrier.
  restore(entity, { instance: { instanceID: id.instanceID, spawnState: { hackingContainers: { [id.key]: record } } } });
  return { ...result, owned: true, duplicate: Boolean(existing), state: record.state,
    failureCount, destroyed, locked: record.state === LOCKED, receipt: { ...receipt } };
}

function getPendingSuccessOutcomes(entity, options = {}) {
  return Object.values(object(getRecord(entity, options)?.outcomes))
    .filter((entry) => entry.outcome === "won" && entry.successEffectsDelivered !== true);
}

function markSuccessEffectsDelivered(entity, outcomeID, options = {}) {
  if (!owns(entity)) return { success: true, owned: false };
  const record = getRecord(entity);
  const receipt = record?.outcomes?.[outcomeID];
  if (!receipt || receipt.outcome !== "won") return { success: false, errorMsg: "HACKING_CONTAINER_WIN_RECEIPT_REQUIRED" };
  receipt.successEffectsDelivered = true;
  receipt.successEffectsDeliveredAtMs = Math.max(1, int(options.nowMs, Date.now()));
  return writeRecord(entity, record, options);
}

function getPendingFailureOutcomes(entity, options = {}) {
  return Object.values(object(getRecord(entity, options)?.outcomes))
    .filter((entry) => entry.outcome === "lost" && entry.failureEffectsDelivered !== true);
}

function markFailureEffectsDelivered(entity, outcomeID, options = {}) {
  if (!owns(entity)) return { success: true, owned: false };
  const record = getRecord(entity);
  const receipt = record?.outcomes?.[outcomeID];
  if (!receipt || receipt.outcome !== "lost") return { success: false, errorMsg: "HACKING_CONTAINER_LOSS_RECEIPT_REQUIRED" };
  receipt.failureEffectsDelivered = true;
  receipt.failureEffectsDeliveredAtMs = Math.max(1, int(options.nowMs, Date.now()));
  return writeRecord(entity, record, options);
}

// Expiry/admin removal retires scene-only mission/encounter effects with their
// site. A server-earned career reward remains payable even when nobody loads
// that scene again, so its durable carrier must settle before it is purged.
function beforePurge(instance) {
  for (const record of Object.values(object(instance?.spawnState?.hackingContainers))) {
    for (const receipt of Object.values(object(record?.outcomes))) {
      if (receipt.outcome !== "won" || receipt.successEffectsDelivered === true || !receipt.careerWin) continue;
      const result = require("../career/careerHackingEvidence").commitPreparedWin(receipt.careerWin);
      if (result?.success !== true) throw new Error(result?.errorMsg || "HACKING_CAREER_SETTLEMENT_PENDING");
    }
  }
  return true;
}

module.exports = { SECURE, BEING_HACKED, HACKED, LOCKED, isHackable, getState, isDestroyed,
  getFailurePolicy, canAttempt,
  setTransientState, getRecord, restore, commitOutcome,
  getPendingSuccessOutcomes, markSuccessEffectsDelivered,
  getPendingFailureOutcomes, markFailureEffectsDelivered, beforePurge };
